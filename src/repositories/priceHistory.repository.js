// src/repositories/priceHistory.repository.js
//
// All direct Mongoose access for the PriceHistory collection. This
// collection is append-only by convention (see PriceHistory.model.js) -
// notice there is deliberately NO updateById/updateOne function exported
// here. deleteAllForProduct is the one intentional exception, reserved
// for cleanup when a Product itself is removed - not for normal request flows.

'use strict';

const PriceHistory = require('../models/PriceHistory.model');

// ── Write ────────────────────────────────────────────────────────────

// Records a single price observation. Most PriceHistory rows will
// actually be written via product.repository.js's upsertFromProviderData
// (which detects a genuine price change during an upsert) - this
// function exists for the separate case of recording a price point
// directly, outside that flow.
async function recordPoint(productId, price, recordedAt) {
    return PriceHistory.create({
        productId,
        price,
        recordedAt: recordedAt || new Date(),
    });
}

// ── Reads ────────────────────────────────────────────────────────────

// Oldest-to-newest, exactly what trend calculation and chart rendering
// need. `since` is optional - pass a Date to limit to recent history
// instead of a product's entire lifetime.
async function findByProduct(productId, since) {
    const filter = { productId };
    if (since) {
        filter.recordedAt = { $gte: since };
    }
    return PriceHistory.find(filter).sort({ recordedAt: 1 }).select('price recordedAt');
}

async function getLatestPrice(productId) {
    return PriceHistory.findOne({ productId }).sort({ recordedAt: -1 }).select('price recordedAt');
}

// ── Delete (admin/cleanup use only - see file header comment) ─────────
async function deleteAllForProduct(productId) {
    return PriceHistory.deleteMany({ productId });
}

module.exports = {
    recordPoint,
    findByProduct,
    getLatestPrice,
    deleteAllForProduct,
};