// src/models/Wishlist.model.js
//
// A lightweight join between User and Product. Product data (price,
// title, image, stock status...) is NEVER duplicated here - always
// fetched via .populate('productId') so it's always current. This
// replaces the old snapshot-based design, which went stale because the
// product's real current price lived in a separate, disconnected place.

'use strict';

const mongoose = require('mongoose');

const wishlistSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    productId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Product',
        required: true,
    },
    // Optional user-facing note, e.g. "for mom's birthday". Not part of
    // your original list, but essentially free given the model already
    // exists - safe to ignore in the UI if you don't want it yet.
    notes: {
        type: String,
        default: null,
        trim: true,
    },
}, {
    timestamps: true, // createdAt = when it was added to the wishlist
});

// Prevent the same user wishlisting the same product twice.
wishlistSchema.index({ userId: 1, productId: 1 }, { unique: true });

// Supports "get this user's wishlist, most recent first" - the actual
// query pattern the wishlist route will use.
wishlistSchema.index({ userId: 1, createdAt: -1 });

const Wishlist = mongoose.model('Wishlist', wishlistSchema);

module.exports = Wishlist;