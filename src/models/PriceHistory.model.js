// src/models/PriceHistory.model.js
//
// Append-only price observation log. One document = one price check for
// one product, at one point in time. Never updated or deleted by the
// app - only ever inserted into. Referenced by productId; title/source/
// url are NOT duplicated here, always joined from the current Product.

'use strict';

const mongoose = require('mongoose');

const priceHistorySchema = new mongoose.Schema({
    productId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Product',
        required: true,
    },
    price: {
        type: Number,
        required: true,
    },
    // Usually identical to createdAt, but kept as its own explicit field
    // so a future backfill/import from an external source isn't forced
    // to misrepresent createdAt (which Mongoose manages specially).
    recordedAt: {
        type: Date,
        default: Date.now,
    },
}, {
    timestamps: true, // createdAt = when OUR system wrote this row
});

// The exact access pattern trend calculation and chart rendering need:
// "this product's price history, oldest to newest."
priceHistorySchema.index({ productId: 1, recordedAt: 1 });

const PriceHistory = mongoose.model('PriceHistory', priceHistorySchema);

module.exports = PriceHistory;