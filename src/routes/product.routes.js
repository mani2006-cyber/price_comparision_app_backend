// src/routes/product.routes.js
//
// Search, product detail, compare-url, and search history endpoints.
// /search uses optionalAuth (works for guests, records history only if
// logged in) - /search/history and its delete route require auth, since
// there's no such thing as a guest's search history.
//
// Caching: product detail and compare-url are cached HERE, at the HTTP
// layer, unconditionally (see cache.middleware.js). Search is NOT -
// it used to be (guest-only, via an HTTP-level cacheResponse just like
// these two), but that meant a cache HIT short-circuited before the
// controller ever ran, and the controller is what records search
// history - so authenticated searches had to skip caching ENTIRELY to
// avoid silently breaking "my recent searches". The cache moved one
// layer down instead: product.service.js's searchAndPersist() now
// caches the expensive marketplace-fetch step itself (by query text
// alone, shared across every caller), while this route's controller
// always runs and always gets a chance to record history, regardless
// of whether the underlying data came from cache or a fresh fetch.

'use strict';

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, optionalAuth } = require('../middleware/auth.middleware');
const { createLimiter } = require('../middleware/rateLimiter.middleware');
const { cacheResponse } = require('../middleware/cache.middleware');
const validate = require('../middleware/validate.middleware');
const { searchQuerySchema, compareUrlBodySchema } = require('../validators/product.validators');
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

const compareCache = cacheResponse({
    keyPrefix: 'compare',
    ttlSeconds: config.cacheTtl.compare,
    keyBuilder: function(req) { return String(req.body.url || '').trim(); },
});

// validate() runs before optionalAuth/compareCache - fail fast on a
// malformed request before touching auth or the cache layer.
router.get('/search', validate({ query: searchQuerySchema }), optionalAuth, asyncHandler(productController.search));
router.get('/search/history', requireAuth, asyncHandler(productController.getSearchHistory));
router.delete('/search/history/:id', requireAuth, asyncHandler(productController.deleteSearchHistoryItem));

router.get('/products/:id', productDetailCache, asyncHandler(productController.getProductDetail));

router.post('/compare-url', validate({ body: compareUrlBodySchema }), compareLimiter, compareCache, asyncHandler(productController.compareUrl));

module.exports = router;