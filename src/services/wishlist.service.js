// src/services/wishlist.service.js
//
// Business logic for the wishlist. Wraps wishlist.repository.js and
// product.repository.js - controllers never touch either directly.
// A wishlist entry is a REFERENCE to a Product, never a snapshot (see
// Wishlist.model.js / File 11) - addToWishlist takes a productId, not
// raw product data.

'use strict';

const ApiError = require('../utils/ApiError');
const wishlistRepository = require('../repositories/wishlist.repository');
const productRepository = require('../repositories/product.repository');

// ── Add ──────────────────────────────────────────────────────────────
async function addToWishlist(userId, productId, notes) {
    const product = await productRepository.findById(productId);
    if (!product) {
        throw ApiError.notFound('Product not found');
    }

    const existing = await wishlistRepository.findByUserAndProduct(userId, productId);
    if (existing) {
        // Explicit, friendly check BEFORE attempting the insert. The unique
        // index on (userId, productId) is still the backstop for a race
        // between this check and the insert below.
        throw ApiError.conflict('This product is already in your wishlist');
    }

    return wishlistRepository.addItem(userId, productId, notes);
}

// ── List ─────────────────────────────────────────────────────────────
// Product data (price, title, stock...) is populated live via
// wishlistRepository.findByUser's own .populate() - never a stale
// snapshot - so no separate per-item enrichment step is needed here.
async function getWishlist(userId) {
    return wishlistRepository.findByUser(userId);
}

// ── Remove ───────────────────────────────────────────────────────────
async function removeFromWishlist(itemId, userId) {
    const result = await wishlistRepository.removeByIdForUser(itemId, userId);

    if (result.deletedCount === 0) {
        // Deliberately 404, not 403 - doesn't confirm to the caller whether
        // this id exists but belongs to someone else, vs. not existing at all.
        throw ApiError.notFound('Wishlist item not found');
    }
}

module.exports = {
    addToWishlist,
    getWishlist,
    removeFromWishlist,
};
