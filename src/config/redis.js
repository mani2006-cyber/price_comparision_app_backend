// src/config/redis.js
//
// Owns the Redis connection. Caching is NEVER a hard dependency - if
// REDIS_ENABLED=false, or Redis is simply unreachable, the app must
// keep working exactly as it does today, just without caching. The
// 'error' listener below is not optional: ioredis (like every Node
// EventEmitter) throws and CRASHES THE PROCESS if an 'error' event
// fires with no listener attached - this listener is what actually
// makes "the app survives a Redis outage" true.

'use strict';

const Redis = require('ioredis');
const config = require('./env');
const logger = require('../utils/logger');

let client = null;
let hasLoggedDownState = false;

if (config.redis.enabled) {
    client = new Redis(config.redis.url, {
        keyPrefix: config.redis.keyPrefix,
        // Fail fast on individual commands rather than queuing them up
        // waiting for a reconnect - a slow/hung cache is worse than no cache.
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        // Keep retrying quietly, capped backoff, forever - so caching comes
        // back on its own if Redis recovers, with no app restart needed.
        retryStrategy: function(times) {
            return Math.min(times * 200, 5000);
        },
    });

    client.on('error', function(err) {
        // Log once per down-state transition, not on every failed command -
        // a real outage would otherwise flood the logs.
        if (!hasLoggedDownState) {
            logger.warn('Redis connection error - caching disabled until it recovers', { message: err.message });
            hasLoggedDownState = true;
        }
    });

    client.on('ready', function() {
        if (hasLoggedDownState) {
            logger.info('Redis reconnected - caching re-enabled');
        } else {
            logger.info('Redis connected');
        }
        hasLoggedDownState = false;
    });
} else {
    logger.info('Redis caching disabled via REDIS_ENABLED=false');
}

function isRedisReady() {
    return !!(config.redis.enabled && client && client.status === 'ready');
}

async function disconnectRedis() {
    if (!client) {
        return;
    }
    try {
        await client.quit();
    } catch (err) {
        // Already down, or failed to quit cleanly - not worth failing
        // process shutdown over a cache connection.
    }
}

module.exports = { client, isRedisReady, disconnectRedis };