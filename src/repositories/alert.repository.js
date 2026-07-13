// src/repositories/alert.repository.js
//
// All direct Mongoose access for the Alert collection. findActiveByProduct
// is the query the price-refresher job depends on - it does the target-
// price comparison IN the query (not in JS afterward) so it scales even
// for products with many alerts. cancelByIdForUser follows the same
// ownership-scoping pattern as wishlist.repository.js.

'use strict';

const Alert = require('../models/Alert.model');

const PRODUCT_POPULATE = 'productId';

// ── Create ───────────────────────────────────────────────────────────
async function create(userId, productId, targetPrice) {
    return Alert.create({ userId, productId, targetPrice });
}

// ── Reads ────────────────────────────────────────────────────────────

async function findByUser(userId) {
    return Alert.find({ userId }).sort({ createdAt: -1 }).populate(PRODUCT_POPULATE);
}

async function findByIdForUser(alertId, userId) {
    return Alert.findOne({ _id: alertId, userId }).populate(PRODUCT_POPULATE);
}

// The core query the price-refresher job runs after every price update:
// all ACTIVE alerts on this product whose target has now been met. The
// comparison happens in the query itself, not in application code, so
// this scales regardless of how many alerts a single popular product
// accumulates.
async function findActiveByProduct(productId, currentPrice) {
    return Alert.find({
        productId,
        status: 'active',
        targetPrice: { $gte: currentPrice },
    });
}

async function countActiveByUser(userId) {
    return Alert.countDocuments({ userId, status: 'active' });
}

// ── Updates ──────────────────────────────────────────────────────────

// Transitions an alert from active -> triggered. The status: 'active'
// filter in the query makes this naturally idempotent - calling it
// again on an already-triggered alert matches nothing and no-ops,
// rather than re-firing a notification.
async function markTriggered(alertId, priceAtTrigger) {
    return Alert.findOneAndUpdate({ _id: alertId, status: 'active' }, {
        status: 'triggered',
        triggeredAt: new Date(),
        triggeredAtPrice: priceAtTrigger,
    }, { new: true });
}

// Ownership-scoped cancel - same pattern as wishlist's removeByIdForUser.
async function cancelByIdForUser(alertId, userId) {
    return Alert.findOneAndUpdate({ _id: alertId, userId, status: 'active' }, { status: 'cancelled' }, { new: true });
}

module.exports = {
    create,
    findByUser,
    findByIdForUser,
    findActiveByProduct,
    countActiveByUser,
    markTriggered,
    cancelByIdForUser,
};