// src/repositories/product.repository.js
//
// All direct Mongoose access for the Product collection. Owns the
// upsert-by-identity logic (marketplace + externalId) that every
// provider adapter's output flows through - this is the ONE place
// price-extreme tracking and price-change detection happen.

'use strict';

const Product = require('../models/Product.model');
const PriceHistory = require('../models/PriceHistory.model');

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

// Products not checked recently - used by the price-refresher job to
// decide what's actually due for a re-check, instead of blindly
// re-scraping everything on a fixed timer regardless of when it was
// last looked at.
async function findStale(olderThanDate, limit) {
    return Product.find({ lastCheckedAt: { $lt: olderThanDate } })
        .sort({ lastCheckedAt: 1 })
        .limit(limit || 100);
}

// Basic text search fallback across our own cached catalog. Not used by
// any service yet, but the repository layer should expose the full
// range of sensible query shapes up front - see file header comment.
async function searchByText(query, limit) {
    return Product.find({ $text: { $search: query } }, { score: { $meta: 'textScore' } })
        .sort({ score: { $meta: 'textScore' } })
        .limit(limit || 20);
}

// ── Writes ───────────────────────────────────────────────────────────

// The single entry point every provider adapter's normalized output
// flows through. Handles: create-if-new, price-change detection,
// price-extreme (lowest/highest) tracking, and lastCheckedAt bookkeeping.
//
// providerData shape (produced by adapters, validated by the service
// layer before this is called):
//   { marketplace, externalId, title, brand, category, images,
//     currentPrice, originalPrice, currency, rating, seller,
//     availability, delivery, rawUrl, keywords, attributes,
//     fetchedVia, metadata }
async function upsertFromProviderData(providerData, session) {
    const options = session ? { session } : {};

    const existing = await Product.findOne({ marketplace: providerData.marketplace, externalId: providerData.externalId },
        null,
        options
    );

    const now = new Date();

    if (!existing) {
        // Brand new product - Product.model.js's pre('save') hook handles
        // slug generation, discount % calculation, and initializing
        // lowestPrice/highestPrice to currentPrice.
        const created = await Product.create(
            [Object.assign({}, providerData, { lastCheckedAt: now, lastPriceChangedAt: now })],
            options
        );
        return { product: created[0], priceChanged: false, isNew: true };
    }

    const priceChanged = existing.currentPrice !== providerData.currentPrice;

    const update = Object.assign({}, providerData, { lastCheckedAt: now });

    // findByIdAndUpdate below is a QUERY-level operation - it does NOT run
    // Product.model.js's pre('save') hook, which is where discountPercentage
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
        await PriceHistory.create(
            [{ productId: existing._id, price: providerData.currentPrice, recordedAt: now }],
            options
        );
    }

    return { product: updated, priceChanged, isNew: false };
}

module.exports = {
    findById,
    findByMarketplaceAndExternalId,
    findManyByIds,
    findStale,
    searchByText,
    upsertFromProviderData,
};