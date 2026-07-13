// src/controllers/wishlist.controller.js
//
// HTTP layer over wishlist.service.js. Every route here requires
// authentication - there's no such thing as a guest wishlist. Ownership
// checks happen in the service layer (File 43); this controller just
// passes req.userId through and lets thrown ApiErrors propagate.

'use strict';

const ApiError = require('../utils/ApiError');
const wishlistService = require('../services/wishlist.service');

async function addItem(req, res) {
    const productId = req.body.productId;
    if (!productId || typeof productId !== 'string') {
        throw ApiError.badRequest("A 'productId' is required");
    }

    const item = await wishlistService.addToWishlist(req.userId, productId, req.body.notes);
    res.status(201).json({ success: true, item });
}

async function getWishlist(req, res) {
    const items = await wishlistService.getWishlistWithPriceHistory(req.userId);
    res.status(200).json({ success: true, count: items.length, items });
}

async function getItemHistory(req, res) {
    const history = await wishlistService.getItemPriceHistory(req.params.id, req.userId);
    res.status(200).json({ success: true, history });
}

async function removeItem(req, res) {
    await wishlistService.removeFromWishlist(req.params.id, req.userId);
    res.status(200).json({ success: true, message: 'Removed from wishlist' });
}

module.exports = { addItem, getWishlist, getItemHistory, removeItem };