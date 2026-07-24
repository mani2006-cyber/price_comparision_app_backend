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
                logger.info('Cache MISS', { key });
                res.set('X-Cache', 'MISS');

                const originalJson = res.json.bind(res);
                res.json = function(body) {
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