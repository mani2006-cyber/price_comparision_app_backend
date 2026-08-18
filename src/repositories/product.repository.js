// src/repositories/product.repository.js
//
// All direct Mongoose access for the Product collection. Owns the
// upsert-by-identity logic (marketplace + externalId) that every
// provider adapter's output flows through - this is the ONE place
// price-extreme tracking (lowestPrice/highestPrice) and price-change
// detection happen. There is no separate per-observation price-history
// log anymore - lowestPrice/highestPrice on the Product document itself
// are the only price-extreme data this app keeps.

'use strict';

const Product = require('../models/Product.model');
const Alert = require('../models/Alert.model');
const cache = require('../utils/cache');

// ── Reads ────────────────────────────────────────────────────────────

async function findById(id) {
    return Product.findById(id);
}

async function findByMarketplaceAndExternalId(marketplace, externalId) {
    return Product.findOne({ marketplace, externalId });
}

async function findManyByIds(ids) {
    return Product.find({ _id: { $in: ids } });
}

// Kept for anything that genuinely wants "every stale product,
// catalog-wide" - NOT used by the price-refresher job anymore (see
// findStaleWithActiveAlerts below for why).
async function findStale(olderThanDate, limit) {
    return Product.find({ lastCheckedAt: { $lt: olderThanDate } })
        .sort({ lastCheckedAt: 1 })
        .limit(limit || 100);
}

// The price-refresher job's real query: stale AND has at least one
// ACTIVE alert riding on it. Re-checking the whole catalog on a fixed
// schedule (the old findStale-based behavior) meant every product ever
// searched - most of which nobody is waiting on a price drop for - got
// a live re-fetch every cycle, which is both wasted work and a real
// path to getting this app's own IP blocked by a marketplace for
// request volume that serves no one. Alert.distinct('productId', ...)
// first, then a plain Product query on that id list - two queries, not
// one aggregation - because Alert and Product are separate collections
// with no $lookup already wired up elsewhere in this codebase, and
// this keeps both queries obvious/independently testable.
async function findStaleWithActiveAlerts(olderThanDate, limit) {
    const alertedProductIds = await Alert.distinct('productId', { status: 'active' });
    if (alertedProductIds.length === 0) {
        return [];
    }

    return Product.find({
        _id: { $in: alertedProductIds },
        lastCheckedAt: { $lt: olderThanDate },
    })
        .sort({ lastCheckedAt: 1 })
        .limit(limit || 100);
}

async function searchByText(query, limit) {
    return Product.find({ $text: { $search: query } }, { score: { $meta: 'textScore' } })
        .sort({ score: { $meta: 'textScore' } })
        .limit(limit || 20);
}

// ── Writes ───────────────────────────────────────────────────────────

async function upsertFromProviderData(providerData, session) {
    const options = session ? { session } : {};

    const existing = await Product.findOne({ marketplace: providerData.marketplace, externalId: providerData.externalId },
        null,
        options
    );

    const now = new Date();

    if (!existing) {
        const created = await Product.create(
            [Object.assign({}, providerData, { lastCheckedAt: now, lastPriceChangedAt: now })],
            options
        );
        return { product: created[0], priceChanged: false, isNew: true };
    }

    const priceChanged = existing.currentPrice !== providerData.currentPrice;

    const update = Object.assign({}, providerData, { lastCheckedAt: now });

    // findByIdAndUpdate below is a QUERY-level operation - it does NOT run
    // Product.model.js's pre('save') hook, where discountPercentage
    // normally gets auto-computed. Without this, every update after the
    // first would silently overwrite a correct discountPercentage with the
    // adapter's default null. Same rule as the model: trust an adapter-
    // supplied value if present, otherwise compute it here.
    if (
        (update.discountPercentage === null || update.discountPercentage === undefined) &&
        update.originalPrice !== null && update.originalPrice !== undefined &&
        update.originalPrice > 0 &&
        update.currentPrice !== null && update.currentPrice !== undefined
    ) {
        const raw = ((update.originalPrice - update.currentPrice) / update.originalPrice) * 100;
        update.discountPercentage = Math.round(raw * 10) / 10;
    }

    if (priceChanged) {
        update.lastPriceChangedAt = now;
        update.lowestPrice = Math.min(existing.lowestPrice, providerData.currentPrice);
        update.highestPrice = Math.max(existing.highestPrice, providerData.currentPrice);
    } else {
        // Price didn't move - preserve existing extremes rather than letting
        // them get silently overwritten by a re-save of unchanged data.
        update.lowestPrice = existing.lowestPrice;
        update.highestPrice = existing.highestPrice;
    }

    const updated = await Product.findByIdAndUpdate(existing._id, update, {
        new: true,
        runValidators: true,
        session: session || undefined,
    });

    if (priceChanged) {
        // Invalidate any cached GET /api/products/:id response for this
        // product - it now holds a stale price. Search-result caches are
        // deliberately left to expire via their own short TTL instead: a
        // single product can appear in many different query/sort/platform
        // cache entries, and enumerating/purging all of them isn't practical.
        await cache.del('product:' + existing._id.toString());
    }

    return { product: updated, priceChanged, isNew: false };
}

module.exports = {
    findById,
    findByMarketplaceAndExternalId,
    findManyByIds,
    findStale,
    findStaleWithActiveAlerts,
    searchByText,
    upsertFromProviderData,
};