// src/services/category.service.js
//
// Category browsing - reads the admin-curated catalog (AdminProduct),
// not scraped/persisted marketplace data (Product). This is the
// read side; adminProduct.service.js is the write side, sitting behind
// adminAuth.middleware.js's shared-secret gate rather than public routes.
//
// getProductListings is the "click a catalog product" flow, and it
// branches on whether the AdminProduct has a `url` (see that model's own
// header comment):
//   - no url (every seeded entry today): a real, live multi-marketplace
//     search keyed by the card's title - reusing search.service.js's
//     runSearch wholesale (same pagination/sorting/persistence GET
//     /search already has). userId is deliberately never passed through,
//     so a catalog click never pollutes a user's search history.
//   - url set: the admin picked one specific listing by hand, so instead
//     of guessing via a title search, run that exact url through the
//     real compare-url pipeline (compareService.compareByUrl) - genuine
//     cross-marketplace matching, price gate, similarProducts, AI
//     summary, all of it.
// Both branches return `listings`/`comparison` respectively, with the
// OTHER key present but null - a stable response shape regardless of
// which mode a given card is in, without breaking anything that already
// only reads `listings` (the seeded catalog's only mode so far).

'use strict';

const ApiError = require('../utils/ApiError');
const adminProductRepository = require('../repositories/adminProduct.repository');
const searchService = require('./search.service');
const compareService = require('./compare.service');
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

    if (adminProduct.url) {
        // page/limit here paginate comparison.similarProducts - see
        // compareByUrl's own comment. No sortBy; compare-url never had
        // one (results[] is always sorted by price ascending already).
        const comparison = await compareService.compareByUrl(adminProduct.url, options);
        return { adminProduct, listings: null, comparison };
    }

    const listings = await searchService.runSearch(adminProduct.title, null, options);
    return { adminProduct, listings, comparison: null };
}

module.exports = { listCategories, getProductsByCategory, getProductListings };
