// src/repositories/adminProduct.repository.js
//
// All direct Mongoose access for the AdminProduct collection - the
// admin-curated catalog that now backs GET /api/categories (see
// category.service.js). Only 'active' entries are ever surfaced through
// the public category-browsing reads below; 'hidden' status lets an
// admin unpublish something without deleting it. The admin CRUD routes
// (adminProduct.service.js) bypass that filter - an admin can see/edit
// their own hidden entries.

'use strict';

const AdminProduct = require('../models/AdminProduct.model');
const cache = require('../utils/cache');

// Same case-insensitive-exact-match collation as the old
// product.repository.js category functions this replaces - so an admin
// typing "Headphones" on one entry and "headphones" on another still
// groups as one category, not two.
const CATEGORY_COLLATION = { locale: 'en', strength: 2 };

function categorySortStage(sortBy) {
    if (sortBy === 'price_asc') return { price: 1 };
    if (sortBy === 'price_desc') return { price: -1 };
    return { createdAt: -1 }; // default: newest-curated first
}

// GET /api/categories caches its whole response under one fixed key (see
// category.routes.js's keyBuilder) - invalidated here, on every write,
// same reasoning product.repository.js's old invalidateCategoryListCache
// had: the list is derived from whatever's currently persisted, and
// without this an admin's newly-added category (or a deleted one) stays
// invisible until the cache entry expires on its own.
const CATEGORY_LIST_CACHE_KEY = 'categories:list';

function invalidateCategoryListCache() {
    // Fire-and-forget: cache.del already swallows its own errors and
    // no-ops when Redis is off, and a failed invalidation must never
    // fail the write that triggered it.
    cache.del(CATEGORY_LIST_CACHE_KEY);
}

// ── Admin CRUD (unfiltered by status - an admin manages their own
// hidden entries too) ───────────────────────────────────────────────────

async function create(data) {
    const created = await AdminProduct.create(data);
    invalidateCategoryListCache();
    return created;
}

async function findById(id) {
    return AdminProduct.findById(id);
}

async function findAll(options) {
    const page = (options && options.page) || 1;
    const limit = (options && options.limit) || 20;
    const filter = (options && options.category) ? { category: options.category.trim() } : {};

    return AdminProduct.find(filter)
        .collation(CATEGORY_COLLATION)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit);
}

async function countAll(options) {
    const filter = (options && options.category) ? { category: options.category.trim() } : {};
    return AdminProduct.countDocuments(filter).collation(CATEGORY_COLLATION);
}

async function updateById(id, data) {
    const updated = await AdminProduct.findByIdAndUpdate(id, data, { new: true, runValidators: true });
    if (updated) {
        invalidateCategoryListCache();
    }
    return updated;
}

async function deleteById(id) {
    const deleted = await AdminProduct.findByIdAndDelete(id);
    if (deleted) {
        invalidateCategoryListCache();
    }
    return deleted;
}

// ── Public category browsing (status: 'active' only) ────────────────────

async function findDistinctCategories() {
    return AdminProduct.aggregate([
        { $match: { status: 'active' } },
        { $group: { _id: '$category', count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
        { $project: { _id: 0, category: '$_id', count: 1 } },
    ]).collation(CATEGORY_COLLATION);
}

// Used by the public "click a catalog product" flow (category.service.js's
// getProductListings) - deliberately status: 'active' scoped, unlike
// findById above (which the admin CRUD layer uses and needs to see its
// own hidden entries through). Without this, a hidden product would still
// be reachable by anyone who guessed/kept its id, even though it's
// invisible in the category listing that would normally surface it.
async function findActiveById(id) {
    return AdminProduct.findOne({ _id: id, status: 'active' });
}

async function findByCategory(category, options) {
    const page = (options && options.page) || 1;
    const limit = (options && options.limit) || 20;

    return AdminProduct.find({ category, status: 'active' })
        .collation(CATEGORY_COLLATION)
        .sort(categorySortStage(options && options.sortBy))
        .skip((page - 1) * limit)
        .limit(limit);
}

async function countByCategory(category) {
    return AdminProduct.countDocuments({ category, status: 'active' }).collation(CATEGORY_COLLATION);
}

module.exports = {
    create,
    findById,
    findAll,
    countAll,
    updateById,
    deleteById,
    findActiveById,
    findDistinctCategories,
    findByCategory,
    countByCategory,
};
