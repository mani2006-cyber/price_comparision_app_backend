// src/routes/product.routes.js
//
// Search, product detail, compare-url, and search history endpoints.
// /search uses optionalAuth (works for guests, records history only if
// logged in) - /search/history and its delete route require auth, since
// there's no such thing as a guest's search history.

'use strict';

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, optionalAuth } = require('../middleware/auth.middleware');
const { createLimiter } = require('../middleware/rateLimiter.middleware');
const productController = require('../controllers/product.controller');

const router = express.Router();

// compare-url is a genuinely more expensive request than a plain search
// (fetches one product detail, THEN runs a full cross-marketplace
// search) - stricter limit than the general apiLimiter app.js applies
// everywhere else.
const compareLimiter = createLimiter({
    windowMs: 60000,
    max: 10,
    message: 'Too many comparison requests, please slow down',
});

router.get('/search', optionalAuth, asyncHandler(productController.search));
router.get('/search/history', requireAuth, asyncHandler(productController.getSearchHistory));
router.delete('/search/history/:id', requireAuth, asyncHandler(productController.deleteSearchHistoryItem));

router.get('/products/:id', asyncHandler(productController.getProductDetail));

router.post('/compare-url', compareLimiter, asyncHandler(productController.compareUrl));

module.exports = router;