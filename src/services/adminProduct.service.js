// src/services/adminProduct.service.js
//
// Admin CRUD over the curated catalog (AdminProduct) that now backs
// public category browsing - see category.service.js for the read side
// consumed by GET /api/categories. This file is the WRITE side, sitting
// behind adminAuth.middleware.js's shared-secret gate, not user auth.

'use strict';

const ApiError = require('../utils/ApiError');
const adminProductRepository = require('../repositories/adminProduct.repository');

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;

async function createProduct(data) {
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
