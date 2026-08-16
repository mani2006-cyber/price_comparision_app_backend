// src/services/category.service.js
//
// Category browsing - lists the distinct categories present in the
// already-persisted catalog, and paginates products within one. Unlike
// search.service.js/product.service.js's searchAndPersist, this NEVER
// hits a marketplace live - it's purely a read over what a prior
// search/compare-url has already saved. See product.repository.js's
// findByCategory/findDistinctCategories for why coverage is partial
// (not every adapter extracts a category).

'use strict';

const ApiError = require('../utils/ApiError');
const productRepository = require('../repositories/product.repository');

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;

async function listCategories() {
    return productRepository.findDistinctCategories();
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
        productRepository.findByCategory(trimmed, { page, limit, sortBy }),
        productRepository.countByCategory(trimmed),
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

module.exports = { listCategories, getProductsByCategory };
