// src/models/Product.model.js
//
// One normalized document per unique real-world product, deduplicated by
// (marketplace, externalId). This is the single shape every provider
// adapter (scraper OR official API) resolves to. Referenced by Wishlist
// and Alert. lowestPrice/highestPrice (below) are the only price-extreme
// data this app keeps - there is no separate per-observation history log.

'use strict';

const mongoose = require('mongoose');

const MARKETPLACES = ['amazon', 'flipkart', 'myntra', 'ajio', 'lenskart', 'nykaa', 'poorvika', 'vijaysales'];
const AVAILABILITY_VALUES = ['in_stock', 'out_of_stock', 'limited', 'preorder', 'unknown'];
const STATUS_VALUES = ['active', 'unavailable', 'discontinued', 'error'];
const MAX_IMAGES = 10;

// ── Embedded sub-schemas (no own _id / collection - they live inline) ──

const ratingSchema = new mongoose.Schema({
    average: { type: Number, default: null },
    reviews: { type: Number, default: null },
}, { _id: false });

const sellerSchema = new mongoose.Schema({
    name: { type: String, default: null },
    rating: { type: Number, default: null },
}, { _id: false });

const deliverySchema = new mongoose.Schema({
    estimate: { type: String, default: null }, // e.g. "2-3 days" - free text, varies too much per provider to structure further
    free: { type: Boolean, default: null },
}, { _id: false });

const productSchema = new mongoose.Schema({
    // ── Identity ────────────────────────────────────────────────────
    marketplace: {
        type: String,
        enum: MARKETPLACES,
        required: true,
    },
    // Extracted deterministically from the product URL by the adapter
    // (Amazon ASIN, Flipkart pid, etc). NEVER randomly generated - this
    // is what makes upserts and cross-search deduplication possible.
    externalId: {
        type: String,
        required: true,
        trim: true,
    },
    sku: {
        type: String,
        default: null,
        trim: true,
    },
    slug: {
        type: String,
        trim: true,
    },

    // ── Display ─────────────────────────────────────────────────────
    title: {
        type: String,
        required: true,
        trim: true,
    },
    brand: {
        type: String,
        default: null,
        trim: true,
    },
    category: {
        type: String,
        default: null,
        trim: true,
    },
    // Breadcrumb, e.g. ["Electronics", "Mobiles", "Smartphones"]
    categoryPath: {
        type: [String],
        default: [],
    },
    // First entry = primary/cover image, by convention. Capped so a
    // scraper bug can't write an unbounded array.
    images: {
        type: [String],
        default: [],
        validate: {
            validator: function(arr) {
                return arr.length <= MAX_IMAGES;
            },
            message: 'A product cannot have more than ' + MAX_IMAGES + ' images',
        },
    },

    // ── Pricing ─────────────────────────────────────────────────────
    currentPrice: {
        type: Number,
        required: true,
    },
    originalPrice: {
        type: Number,
        default: null,
    },
    discountPercentage: {
        type: Number,
        default: null,
    },
    currency: {
        type: String,
        default: 'INR',
    },
    // Extremes ever observed for this product. Initialized to
    // currentPrice on creation; updated by the price-recording SERVICE
    // (not this model) whenever a genuine new low/high comes in.
    lowestPrice: {
        type: Number,
        default: null,
    },
    highestPrice: {
        type: Number,
        default: null,
    },

    // ── Ratings / seller ────────────────────────────────────────────
    rating: {
        type: ratingSchema,
        default: function() { return { average: null, reviews: null }; },
    },
    seller: {
        type: sellerSchema,
        default: function() { return { name: null, rating: null }; },
    },

    // ── Availability ────────────────────────────────────────────────
    availability: {
        type: String,
        enum: AVAILABILITY_VALUES,
        default: 'unknown',
    },
    // Denormalized boolean for cheap filtering (e.g. "hide out of stock"
    // list queries) without every caller having to know the enum values.
    inStock: {
        type: Boolean,
        default: true,
    },
    delivery: {
        type: deliverySchema,
        default: function() { return { estimate: null, free: null }; },
    },

    // ── Links ───────────────────────────────────────────────────────
    rawUrl: {
        type: String,
        required: true,
    },
    affiliateUrl: {
        type: String,
        default: null,
    },

    // ── Search ──────────────────────────────────────────────────────
    // Tokenized title/brand words, used for lightweight cross-marketplace
    // matching (replaces the ad-hoc tokenize() in the old similarity.js -
    // that logic still runs at search time, but we persist the tokens so
    // future features, like "related products", don't need to retokenize).
    keywords: {
        type: [String],
        default: [],
    },

    // ── Specifications ──────────────────────────────────────────────
    // Flexible per-category specs (RAM, Storage, Color, Size...) as a
    // Map, not Mixed - stays queryable/typed, unlike an opaque blob.
    attributes: {
        type: Map,
        of: String,
        default: function() { return new Map(); },
    },

    // ── Tracking ────────────────────────────────────────────────────
    // "scraper" or "api" - which provider MODE produced this snapshot,
    // independent of which marketplace it's from. Useful for debugging
    // data quality after a provider switch.
    fetchedVia: {
        type: String,
        enum: ['scraper', 'api'],
        required: true,
    },
    // Updates on EVERY check, whether or not the price moved.
    lastCheckedAt: {
        type: Date,
        default: Date.now,
    },
    // Updates ONLY when the price actually changed. Lets alerting logic
    // query cheaply: "has anything changed since I last notified?"
    lastPriceChangedAt: {
        type: Date,
        default: Date.now,
    },
    status: {
        type: String,
        enum: STATUS_VALUES,
        default: 'active',
    },

    // ── Metadata ────────────────────────────────────────────────────
    // Genuine catch-all for provider-specific fields we haven't modeled
    // yet (warranty terms, EMI options, variant lists...). Deliberately
    // Mixed, unlike `attributes` above - this is for "preserve it",
    // not "expose it as a queryable spec".
    metadata: {
        type: mongoose.Schema.Types.Mixed,
        default: {},
    },
}, {
    timestamps: true, // createdAt, updatedAt
});

// ── Slug generation ──────────────────────────────────────────────────
function slugify(str) {
    return String(str)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
}

productSchema.pre('save', function(next) {
    // Slug: human-readable but not relied on for identity (externalId is).
    // Suffixed with externalId to avoid collisions between different
    // products that happen to have similar titles.
    if (!this.slug) {
        this.slug = slugify(this.title) + '-' + slugify(this.externalId);
    }

    // Auto-compute discount % only if not explicitly provided (an official
    // API may hand us its own authoritative value - trust that over our math).
    if (
        this.discountPercentage === null &&
        this.originalPrice !== null &&
        this.originalPrice > 0 &&
        this.currentPrice !== null
    ) {
        const raw = ((this.originalPrice - this.currentPrice) / this.originalPrice) * 100;
        this.discountPercentage = Math.round(raw * 10) / 10;
    }

    // Initialize price extremes on first creation only.
    if (this.isNew) {
        if (this.lowestPrice === null) this.lowestPrice = this.currentPrice;
        if (this.highestPrice === null) this.highestPrice = this.currentPrice;
    }

    // Keep inStock boolean consistent with the availability enum, unless
    // a caller explicitly set inStock themselves in the same update.
    if (this.availability === 'in_stock' || this.availability === 'limited') {
        this.inStock = true;
    } else if (this.availability === 'out_of_stock') {
        this.inStock = false;
    }

    next();
});

// One product per (marketplace, externalId) - the upsert key every
// adapter result gets written through.
productSchema.index({ marketplace: 1, externalId: 1 }, { unique: true });

// Supports "find products not checked recently" queries for the refresher.
productSchema.index({ lastCheckedAt: 1 });

// Supports category-browsing (GET /api/categories/:category/products).
// Sparse - most documents have category: null (not every adapter
// extracts one; see product.repository.js's findDistinctCategories
// comment), and a sparse index skips those entirely rather than
// wasting space indexing a field three-quarters of the collection
// doesn't have.
productSchema.index({ category: 1 }, { sparse: true });

// Text search fallback across title, brand, and persisted keywords.
productSchema.index({ title: 'text', brand: 'text', keywords: 'text' });

const Product = mongoose.model('Product', productSchema);

module.exports = Product;
module.exports.MARKETPLACES = MARKETPLACES;
module.exports.AVAILABILITY_VALUES = AVAILABILITY_VALUES;
module.exports.STATUS_VALUES = STATUS_VALUES;