// src/services/wishlist.service.js
//
// Business logic for the wishlist. Wraps wishlist.repository.js and
// priceHistory.repository.js - controllers never touch either directly.
// A wishlist entry is a REFERENCE to a Product, never a snapshot (see
// Wishlist.model.js / File 11) - addToWishlist takes a productId, not
// raw product data.

'use strict';

const ApiError = require('../utils/ApiError');
const wishlistRepository = require('../repositories/wishlist.repository');
const productRepository = require('../repositories/product.repository');
const priceHistoryRepository = require('../repositories/priceHistory.repository');

const RECENT_HISTORY_DAYS = 30;

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

// ── List (with recent price history per item) ───────────────────────
async function getWishlistWithPriceHistory(userId) {
    const items = await wishlistRepository.findByUser(userId);

    const since = new Date(Date.now() - RECENT_HISTORY_DAYS * 24 * 60 * 60 * 1000);

    const withHistory = await Promise.all(
        items.map(async function(item) {
            // productId is already populated by findByUser (File 18) - if a
            // referenced Product was ever deleted, populate() leaves this
            // null rather than throwing; skip history lookup in that edge case.
            if (!item.productId) {
                return { item, priceHistory: [] };
            }

            const priceHistory = await priceHistoryRepository.findByProduct(item.productId._id, since);
            return { item, priceHistory };
        })
    );

    return withHistory;
}

// ── Single item's full price history (not capped to 30 days) ────────
async function getItemPriceHistory(itemId, userId) {
    const item = await wishlistRepository.findByIdForUser(itemId, userId);
    if (!item) {
        throw ApiError.notFound('Wishlist item not found');
    }

    return priceHistoryRepository.findByProduct(item.productId._id);
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
    getWishlistWithPriceHistory,
    getItemPriceHistory,
    removeFromWishlist,
};