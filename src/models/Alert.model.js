// src/models/Alert.model.js
//
// A user's request to be notified when a product's price drops to or
// below a target value. References User + Product - the alert itself
// holds no product data (price, title, etc.), same reasoning as Wishlist.

'use strict';

const mongoose = require('mongoose');

const STATUS_VALUES = ['active', 'triggered', 'cancelled'];

const alertSchema = new mongoose.Schema({
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
    targetPrice: {
        type: Number,
        required: true,
        min: [1, 'targetPrice must be a positive number'],
    },
    status: {
        type: String,
        enum: STATUS_VALUES,
        default: 'active',
    },
    // Set once, the moment the alert actually fires. Null until then.
    // The price-refresher job checks this to avoid re-notifying for the
    // same trigger repeatedly.
    triggeredAt: {
        type: Date,
        default: null,
    },
    // The product's price at the moment this alert fired - kept here
    // (not just inferred from Product.currentPrice) because the product
    // price may have changed again by the time someone looks at this
    // alert's history.
    triggeredAtPrice: {
        type: Number,
        default: null,
    },
}, {
    timestamps: true,
});

// Deliberately NOT unique - a user may want multiple alerts on the same
// product at different target prices. This index supports the common
// query patterns instead: "this user's active alerts", and (from the
// refresher job's side) "all active alerts for this product".
alertSchema.index({ userId: 1, productId: 1, status: 1 });
alertSchema.index({ productId: 1, status: 1 });

const Alert = mongoose.model('Alert', alertSchema);

module.exports = Alert;
module.exports.STATUS_VALUES = STATUS_VALUES;