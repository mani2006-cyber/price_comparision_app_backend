// src/repositories/wishlist.repository.js
//
// All direct Mongoose access for the Wishlist collection. Every read
// returns populated Product data - a wishlist entry is meaningless
// without title/price/image, so callers should never need to remember
// to populate it themselves. Ownership-scoped functions (findByIdForUser,
// removeByIdForUser) filter by BOTH the item id AND userId together, so
// a user can never access another user's wishlist item by guessing an id.

'use strict';

const Wishlist = require('../models/Wishlist.model');

const PRODUCT_POPULATE = 'productId';

// ── Create ───────────────────────────────────────────────────────────
async function addItem(userId, productId, notes) {
    return Wishlist.create({ userId, productId, notes: notes || null });
}

// ── Reads ────────────────────────────────────────────────────────────

async function findByUser(userId) {
    return Wishlist.find({ userId }).sort({ createdAt: -1 }).populate(PRODUCT_POPULATE);
}

// Ownership-scoped: only returns the item if it belongs to this user.
async function findByIdForUser(itemId, userId) {
    return Wishlist.findOne({ _id: itemId, userId }).populate(PRODUCT_POPULATE);
}

// Used by the service layer to give a clean "already wishlisted" check
// before attempting an insert.
async function findByUserAndProduct(userId, productId) {
    return Wishlist.findOne({ userId, productId });
}

async function countByUser(userId) {
    return Wishlist.countDocuments({ userId });
}

// ── Delete ───────────────────────────────────────────────────────────

// Ownership-scoped delete - returns the delete result so the service
// layer can tell "deleted" apart from "not found / not yours" by
// checking deletedCount, same pattern as the old learn/ routes used.
async function removeByIdForUser(itemId, userId) {
    return Wishlist.deleteOne({ _id: itemId, userId });
}

module.exports = {
    addItem,
    findByUser,
    findByIdForUser,
    findByUserAndProduct,
    countByUser,
    removeByIdForUser,
};