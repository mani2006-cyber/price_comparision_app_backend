// src/middleware/cache.middleware.js
//
// Generic response-caching middleware factory for GET (or any) JSON
// routes. On a cache hit, responds immediately without reaching the
// controller. On a miss, lets the request proceed normally and
// transparently caches whatever 2xx JSON response the controller
// produces, fire-and-forget (never delays or fails the actual response).

'use strict';

const cache = require('../utils/cache');
const logger = require('../utils/logger');

// Same in-flight de-duplication as cache.js's getOrSet, adapted for a
// middleware whose "computation" is an entire request/response cycle
// rather than a plain async function - see cache.js's own comment for
// why this exists at all (confirmed live: two near-simultaneous
// compare-url requests for the same URL both missed the cache and both
// ran the full marketplace-search + AI-summary pipeline). Keyed by the
// SAME prefixed key cache.get/set already use, so it's naturally scoped
// per-route without needing a separate namespace.
//
// Each entry is a Promise<{ statusCode, body }> - resolving with the
// STATUS CODE too (not just the body) matters because the first request
// for a key might legitimately produce an error response (e.g. a
// CastError -> 400 on a malformed id); a coalesced follower has to
// replay that exact response, not silently repackage an error body
// under a 200.
const inFlight = new Map();

// options:
//   keyPrefix  - string, namespaces this route's cache entries
//   ttlSeconds - number
//   keyBuilder - function(req) -> string, must be deterministic
//   skip       - optional function(req) -> boolean, opts a request out
//                entirely (e.g. authenticated requests with a side
//                effect a cache hit would silently bypass)
function cacheResponse(options) {
    const skip = options.skip || function() { return false; };

    return function(req, res, next) {
        if (skip(req)) {
            return next();
        }

        const key = options.keyPrefix + ':' + options.keyBuilder(req);

        cache.get(key)
            .then(function(cached) {
                if (cached !== null) {
                    logger.info('Cache HIT', { key });
                    res.set('X-Cache', 'HIT');
                    return res.status(200).json(cached);
                }

                const existing = inFlight.get(key);
                if (existing) {
                    logger.info('Cache MISS (coalesced with an in-flight request)', { key });
                    res.set('X-Cache', 'MISS');
                    return existing.then(function(result) {
                        res.status(result.statusCode).json(result.body);
                    });
                }

                logger.info('Cache MISS', { key });
                res.set('X-Cache', 'MISS');

                let settle;
                const promise = new Promise(function(resolve) { settle = resolve; });
                inFlight.set(key, promise);

                // Safety net: if the response ends WITHOUT ever going
                // through res.json below (a raw res.end() somewhere, a
                // socket close, anything unforeseen), this still settles
                // the promise (so no coalesced follower hangs forever)
                // AND removes it from the map (so the NEXT request for
                // this key starts a fresh computation instead of finding
                // a stale, already-settled promise sitting there forever -
                // res.json's own path below does both together too; a
                // Promise only ever settles once, and deleting an
                // already-deleted map key is a harmless no-op, so it's
                // safe for both paths to run regardless of which fires).
                res.once('finish', settleFromCurrentResponse);
                res.once('close', settleFromCurrentResponse);
                function settleFromCurrentResponse() {
                    inFlight.delete(key);
                    settle({ statusCode: res.statusCode || 500, body: { success: false, error: 'Request failed' } });
                }

                const originalJson = res.json.bind(res);
                res.json = function(body) {
                    inFlight.delete(key);
                    settle({ statusCode: res.statusCode, body: body });
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        Promise.resolve(cache.set(key, body, options.ttlSeconds)).catch(function() {});
                    }
                    return originalJson(body);
                };

                next();
            })
            .catch(function(err) {
                logger.debug('Cache middleware lookup failed, proceeding without cache', { key, message: err.message });
                next();
            });
    };
}

module.exports = { cacheResponse };