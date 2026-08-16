// src/utils/cache.js
//
// Every function here is safe to call unconditionally from anywhere in
// the app - if Redis is disabled or unreachable, every function is a
// silent no-op (get returns null, set/del return false), never throws,
// never delays the caller. This is what lets services/repositories call
// cache functions without any Redis-specific error handling of their own.

'use strict';

const logger = require('./logger');
const { client, isRedisReady } = require('../config/redis');

async function get(key) {
    if (!isRedisReady()) {
        return null;
    }
    try {
        const raw = await client.get(key);
        return raw ? JSON.parse(raw) : null;
    } catch (err) {
        logger.debug('Cache get failed, treating as a miss', { key, message: err.message });
        return null;
    }
}

async function set(key, value, ttlSeconds) {
    if (!isRedisReady()) {
        return false;
    }
    try {
        await client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
        return true;
    } catch (err) {
        logger.debug('Cache set failed, continuing without caching this response', { key, message: err.message });
        return false;
    }
}

async function del(key) {
    if (!isRedisReady()) {
        return false;
    }
    try {
        await client.del(key);
        return true;
    } catch (err) {
        logger.debug('Cache invalidation failed', { key, message: err.message });
        return false;
    }
}

// In-flight de-duplication ("singleflight"): if two callers ask for the
// same key while nobody has cached it YET, both used to independently
// call fetchFn() - confirmed live on a real compare-url request: two
// near-simultaneous calls both missed the cache (neither had finished
// writing yet), so BOTH ran the full marketplace search + AI-summary
// pipeline, doubling live scraper request volume and OpenRouter usage
// for what was really one logical request. This map tracks a Promise
// per key that's currently being computed - a second caller for the
// same key awaits THAT promise instead of starting its own fetchFn().
// Module-level (not per-call) is the point - it has to be shared across
// concurrent invocations to actually coalesce anything.
const inFlight = new Map();

// Cache-aside helper: returns the cached value if present, otherwise
// calls fetchFn(), caches its result, and returns it. fetchFn's result
// is always returned even if the cache write itself fails.
async function getOrSet(key, ttlSeconds, fetchFn) {
    const cached = await get(key);
    if (cached !== null) {
        return { value: cached, fromCache: true };
    }

    const existing = inFlight.get(key);
    if (existing) {
        // Coalesced onto someone else's in-progress fetch - genuinely
        // fresh data, just not fetched by THIS call, so fromCache stays
        // false (it would be misleading to call this a cache hit; it
        // never touched Redis).
        const value = await existing;
        return { value, fromCache: false };
    }

    const promise = fetchFn().finally(function() {
        inFlight.delete(key);
    });
    inFlight.set(key, promise);

    const fresh = await promise;
    await set(key, fresh, ttlSeconds);
    return { value: fresh, fromCache: false };
}

module.exports = { get, set, del, getOrSet };