// src/routes/product.routes.js
//
// Search, product detail, compare-url, and search history endpoints.
// /search uses optionalAuth (works for guests, records history only if
// logged in) - /search/history and its delete route require auth, since
// there's no such thing as a guest's search history.
//
// Caching: product detail is cached HERE, at the HTTP layer,
// unconditionally (see cache.middleware.js). Search and compare-url are
// NOT - both used to be (search: guest-only; compare-url: unconditionally),
// but both moved the SAME way, one layer down into their own service
// (product.service.js's searchAndPersist, compare.service.js's
// computeComparison), for two related reasons: search's controller has
// to run every time to record history (a cache HIT at the HTTP layer
// would skip it), and compare-url's result.similarProducts is now
// PAGINATED - an HTTP-level whole-response cache keyed on the URL alone
// would freeze whichever page got requested first and serve that exact
// page to everyone for the rest of the TTL. Caching one layer down
// means the expensive part (the live search, the AI summary call) is
// still shared/cached, while whatever runs on top of it (history
// recording, pagination) is always fresh per request.

'use strict';

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, optionalAuth } = require('../middleware/auth.middleware');
const { createLimiter } = require('../middleware/rateLimiter.middleware');
const { cacheResponse } = require('../middleware/cache.middleware');
const validate = require('../middleware/validate.middleware');
const { searchQuerySchema, compareUrlBodySchema, compareUrlQuerySchema } = require('../validators/product.validators');
const config = require('../config/env');
const productController = require('../controllers/product.controller');

const router = express.Router();

const compareLimiter = createLimiter({
    windowMs: config.compareRateLimit.windowMs,
    max: config.compareRateLimit.max,
    message: 'Too many comparison requests, please slow down',
});

const productDetailCache = cacheResponse({
    keyPrefix: 'product',
    ttlSeconds: config.cacheTtl.product,
    keyBuilder: function(req) { return req.params.id; },
});

// validate() runs before optionalAuth - fail fast on a malformed request
// before touching auth.
router.get('/search', validate({ query: searchQuerySchema }), optionalAuth, asyncHandler(productController.search));
router.get('/search/history', requireAuth, asyncHandler(productController.getSearchHistory));
router.delete('/search/history/:id', requireAuth, asyncHandler(productController.deleteSearchHistoryItem));

router.get('/products/:id', productDetailCache, asyncHandler(productController.getProductDetail));

router.post(
    '/compare-url',
    validate({ body: compareUrlBodySchema, query: compareUrlQuerySchema }),
    compareLimiter,
    asyncHandler(productController.compareUrl)
);

module.exports = router;