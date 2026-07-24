// src/routes/product.routes.js
//
// Search, product detail, compare-url, and search history endpoints.
// /search uses optionalAuth (works for guests, records history only if
// logged in) - /search/history and its delete route require auth, since
// there's no such thing as a guest's search history.
//
// Caching: search is cached ONLY for guest requests (an authenticated
// search has a side effect - recording history - that a cache hit would
// silently skip). Product detail and compare-url are cached
// unconditionally. See cache.middleware.js.

'use strict';

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, optionalAuth } = require('../middleware/auth.middleware');
const { createLimiter } = require('../middleware/rateLimiter.middleware');
const { cacheResponse } = require('../middleware/cache.middleware');
const config = require('../config/env');
const productController = require('../controllers/product.controller');

const router = express.Router();

const compareLimiter = createLimiter({
    windowMs: 60000,
    max: 10,
    message: 'Too many comparison requests, please slow down',
});

const searchCache = cacheResponse({
    keyPrefix: 'search',
    ttlSeconds: config.cacheTtl.search,
    skip: function(req) {
        // An authenticated search records history as a side effect
        // (search.service.js) - a cache hit would bypass that entirely,
        // silently breaking "my recent searches" for logged-in users.
        return !!req.headers.authorization;
    },
    keyBuilder: function(req) {
        const q = String(req.query.q || '').trim().toLowerCase();
        const sortBy = req.query.sortBy || 'default';
        const platform = req.query.platform || 'all';
        return q + ':' + sortBy + ':' + platform;
    },
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

router.get('/search', optionalAuth, searchCache, asyncHandler(productController.search));
router.get('/search/history', requireAuth, asyncHandler(productController.getSearchHistory));
router.delete('/search/history/:id', requireAuth, asyncHandler(productController.deleteSearchHistoryItem));

router.get('/products/:id', productDetailCache, asyncHandler(productController.getProductDetail));

router.post('/compare-url', compareLimiter, compareCache, asyncHandler(productController.compareUrl));

module.exports = router;