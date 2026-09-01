// src/routes/category.routes.js
//
// Category browsing - public, read-only, no auth (same reasoning as
// GET /products/:id). All three routes are HTTP-level cached the same
// way product detail/compare-url are: none of them has a per-user side
// effect (the /:id listings route deliberately never records search
// history - see category.service.js's getProductListings), so a cache
// HIT short-circuiting before the controller is exactly what should
// happen (unlike /search, which always has to run the controller to
// record history - see product.routes.js's own header comment for that
// contrast).

'use strict';

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { cacheResponse } = require('../middleware/cache.middleware');
const validate = require('../middleware/validate.middleware');
const { categoryProductsQuerySchema } = require('../validators/product.validators');
const config = require('../config/env');
const categoryController = require('../controllers/category.controller');

const router = express.Router();

const categoryListCache = cacheResponse({
    keyPrefix: 'categories',
    ttlSeconds: config.cacheTtl.category,
    keyBuilder: function() { return 'list'; }, // one shared entry - no per-request variance
});

const categoryProductsCache = cacheResponse({
    keyPrefix: 'category-products',
    ttlSeconds: config.cacheTtl.category,
    // Case folded so "Headphones" and "headphones" share one cache entry,
    // matching findByCategory's own case-insensitive collation.
    keyBuilder: function(req) {
        return req.params.category.trim().toLowerCase() + ':' +
            (req.query.sortBy || '') + ':' + (req.query.page || '1') + ':' + (req.query.limit || '20');
    },
});

// Separate cache namespace from categoryProductsCache above - keyed by
// the admin product's own id (globally unique), not by category, so the
// :category segment in the URL doesn't need to be part of the key.
const productListingsCache = cacheResponse({
    keyPrefix: 'category-product-listings',
    ttlSeconds: config.cacheTtl.category,
    keyBuilder: function(req) {
        return req.params.id + ':' +
            (req.query.sortBy || '') + ':' + (req.query.page || '1') + ':' + (req.query.limit || '20');
    },
});

router.get('/', categoryListCache, asyncHandler(categoryController.listCategories));
router.get(
    '/:category/products',
    validate({ query: categoryProductsQuerySchema }),
    categoryProductsCache,
    asyncHandler(categoryController.getCategoryProducts)
);
router.get(
    '/:category/products/:id',
    validate({ query: categoryProductsQuerySchema }),
    productListingsCache,
    asyncHandler(categoryController.getProductListings)
);

module.exports = router;
