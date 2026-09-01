// src/services/adminProduct.service.js
//
// Admin CRUD over the curated catalog (AdminProduct) that now backs
// public category browsing - see category.service.js for the read side
// consumed by GET /api/categories. This file is the WRITE side, sitting
// behind adminAuth.middleware.js's shared-secret gate, not user auth.

'use strict';

const ApiError = require('../utils/ApiError');
const adapters = require('../adapters');
const adminProductRepository = require('../repositories/adminProduct.repository');

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;

// Same check compareByUrl itself does at click time (compare.service.js) -
// duplicated here deliberately so an admin gets a clean 400 for an
// unsupported url immediately at creation/update time, rather than
// only discovering it later when a user actually clicks the card. Only
// called when url is actually provided - it's an optional field (see
// AdminProduct.model.js's own comment).
function assertSupportedUrl(url) {
    if (!adapters.detectMarketplaceFromUrl(url)) {
        let activeList = 'amazon, flipkart, myntra, lenskart, nykaa, poorvika, vijaysales';
        try {
            const active = adapters.getActiveMarketplaces();
            if (Array.isArray(active) && active.length > 0) {
                activeList = active.join(', ');
            }
        } catch (err) {
            // Fall through to the hardcoded default above.
        }
        throw ApiError.badRequest("'url' not recognized. Supported marketplaces: " + activeList);
    }
}

async function createProduct(data) {
    if (data.url) {
        assertSupportedUrl(data.url);
    }
    return adminProductRepository.create(data);
}

async function listProducts(options) {
    const page = (options && options.page) || DEFAULT_PAGE;
    const limit = (options && options.limit) || DEFAULT_LIMIT;
    const category = options && options.category;

    const [products, total] = await Promise.all([
        adminProductRepository.findAll({ page, limit, category }),
        adminProductRepository.countAll({ category }),
    ]);

    return {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 0,
        products,
    };
}

async function getProduct(id) {
    const product = await adminProductRepository.findById(id);
    if (!product) {
        throw ApiError.notFound('Catalog product not found');
    }
    return product;
}

async function updateProduct(id, data) {
    if (data.url) {
        assertSupportedUrl(data.url);
    }
    const updated = await adminProductRepository.updateById(id, data);
    if (!updated) {
        throw ApiError.notFound('Catalog product not found');
    }
    return updated;
}

async function deleteProduct(id) {
    const deleted = await adminProductRepository.deleteById(id);
    if (!deleted) {
        throw ApiError.notFound('Catalog product not found');
    }
    return deleted;
}

module.exports = { createProduct, listProducts, getProduct, updateProduct, deleteProduct };
