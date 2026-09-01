// src/models/AdminProduct.model.js
//
// A manually-curated catalog entry, used to populate category browsing
// (GET /api/categories) - deliberately separate from Product.model.js,
// which is the marketplace-comparison entity keyed by (marketplace,
// externalId) and driven by live scraper/API data.
//
// `url` is OPTIONAL, and it changes what a click on this card does (see
// category.service.js's getProductListings): with no url (the seeded
// catalog's 90 entries, still title-only), a click runs a plain live
// title search across marketplaces, same as GET /search. With a url set
// - one specific marketplace listing the admin picked by hand - a click
// instead runs the real compare-url pipeline against it (live fetch,
// genuine cross-marketplace matching, price gate, similarProducts, AI
// summary). Deliberately backward-compatible: existing url-less entries
// and whatever already consumes their response shape keep working
// completely unchanged.

'use strict';

const mongoose = require('mongoose');

const STATUS_VALUES = ['active', 'hidden'];

const adminProductSchema = new mongoose.Schema({
    title: {
        type: String,
        required: true,
        trim: true,
    },
    description: {
        type: String,
        default: null,
        trim: true,
    },
    category: {
        type: String,
        required: true,
        trim: true,
    },
    // Display/reference price only - NOT tied to any live marketplace
    // listing (there isn't one until a user clicks through and triggers
    // a real search). Whatever the admin wants shown on the catalog card.
    price: {
        type: Number,
        required: true,
    },
    // Optional - see this file's own header comment for how its
    // presence/absence changes what a click on this card does.
    // Validated against a supported marketplace at write time too, not
    // just at click time, when provided - see adminProduct.service.js.
    url: {
        type: String,
        default: null,
        trim: true,
    },
    image: {
        type: String,
        default: null,
    },
    slug: {
        type: String,
        trim: true,
    },
    status: {
        type: String,
        enum: STATUS_VALUES,
        default: 'active',
    },
}, {
    timestamps: true, // createdAt, updatedAt
});

function slugify(str) {
    return String(str)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
}

adminProductSchema.pre('save', function(next) {
    // Same pattern as Product.model.js: human-readable, not relied on for
    // identity. Suffixed with the Mongo _id (always present by the time
    // this hook runs on a new document) to avoid collisions between
    // different entries that happen to share a title.
    if (!this.slug) {
        this.slug = slugify(this.title) + '-' + this._id.toString();
    }
    next();
});

// Category browsing's actual query pattern: distinct categories, and
// paginated products within one. Same case-insensitive collation
// reasoning as the old product.repository.js version this replaces -
// see adminProduct.repository.js's own comment.
adminProductSchema.index({ category: 1, createdAt: -1 });

const AdminProduct = mongoose.model('AdminProduct', adminProductSchema);

module.exports = AdminProduct;
module.exports.STATUS_VALUES = STATUS_VALUES;
