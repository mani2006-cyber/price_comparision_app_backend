// src/services/category.service.js
//
// Category browsing - reads the admin-curated catalog (AdminProduct),
// not scraped/persisted marketplace data (Product). This is the
// read side; adminProduct.service.js is the write side, sitting behind
// adminAuth.middleware.js's shared-secret gate rather than public routes.
//
// getProductListings is the "click a catalog product" flow: an
// AdminProduct entry has no real marketplace listing behind it (see
// AdminProduct.model.js's own comment), so clicking one triggers a real,
// live multi-marketplace search keyed by its title - reusing
// search.service.js's runSearch wholesale (same pagination/sorting/
// persistence it already has for GET /search) rather than duplicating
// that logic here. userId is deliberately never passed through, so a
// catalog click never pollutes a user's search history - they didn't
// type this query, they clicked a card.

'use strict';

const ApiError = require('../utils/ApiError');
const adminProductRepository = require('../repositories/adminProduct.repository');
const searchService = require('./search.service');
const config = require('../config/env');

const DEFAULT_PAGE = 1; // pagination always starts at 1 - not a tunable, unlike the limit below
const DEFAULT_LIMIT = config.category.defaultLimit;

async function listCategories() {
    return adminProductRepository.findDistinctCategories();
}

async function getProductsByCategory(category, options) {
    const trimmed = (category || '').trim();
    if (!trimmed) {
        throw ApiError.badRequest("A 'category' is required");
    }

    const page = (options && options.page) || DEFAULT_PAGE;
    const limit = (options && options.limit) || DEFAULT_LIMIT;
    const sortBy = options && options.sortBy;

    const [products, total] = await Promise.all([
        adminProductRepository.findByCategory(trimmed, { page, limit, sortBy }),
        adminProductRepository.countByCategory(trimmed),
    ]);

    return {
        category: trimmed,
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 0,
        products,
    };
}

async function getProductListings(id, options) {
    const adminProduct = await adminProductRepository.findActiveById(id);
    if (!adminProduct) {
        throw ApiError.notFound('Catalog product not found');
    }

    const listings = await searchService.runSearch(adminProduct.title, null, options);

    return { adminProduct, listings };
}

module.exports = { listCategories, getProductsByCategory, getProductListings };
