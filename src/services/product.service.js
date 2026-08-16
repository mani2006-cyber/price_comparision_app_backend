// src/services/product.service.js
//
// Wraps adapters/index.js (live marketplace data) + product.repository.js
// (persistence/upsert) together. Every other service that needs product
// data builds on this one - nobody else talks to adapters or the
// product repository directly.

'use strict';

const adapters = require('../adapters');
const productRepository = require('../repositories/product.repository');
const cache = require('../utils/cache');
const config = require('../config/env');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

const UPSERT_CHUNK_SIZE = 5;

// Cache key is the normalized QUERY ONLY - deliberately ignores
// options.sortBy/platform. sortBy never reaches adapters.searchAllMarketplaces
// at all (search.service.js's runSearch sorts the array searchAndPersist
// already returned, entirely after this function is done); platform is
// accepted and recorded to search history but does not currently filter
// which marketplaces get searched (see adapters/index.js's
// searchAllMarketplaces - it always searches every active marketplace).
// Both are therefore invariant to the actual work this function caches.
// If platform-based filtering is ever implemented, THIS key must be
// updated to include it, or two different platform filters would
// silently share one cache entry and serve each other's results.
function searchCacheKey(query) {
    return 'search:' + String(query).trim().toLowerCase();
}

// Splits an array into fixed-size chunks - used to upsert search results
// in controlled batches rather than firing all of them simultaneously.
function chunk(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
}

// Upserts one ProviderProduct result. Never throws - logs and returns
// null on failure, so one bad row can't take down an otherwise-
// successful batch of persistence.
async function upsertSafely(providerProduct) {
    try {
        const outcome = await productRepository.upsertFromProviderData(providerProduct);
        return outcome.product;
    } catch (err) {
        logger.error('Failed to persist a search result - skipping this item', {
            marketplace: providerProduct.marketplace,
            externalId: providerProduct.externalId,
            message: err.message,
        });
        return null;
    }
}

// Does the actual work: live marketplace search, then persist every
// result. This is the expensive part (real HTTP calls out to every
// marketplace, plus a MongoDB upsert per result) - searchAndPersist
// below wraps it in a cache-aside, this function itself knows nothing
// about caching.
async function fetchAndPersist(query, options) {
    const { results, failures } = await adapters.searchAllMarketplaces(query, options);

    const batches = chunk(results, UPSERT_CHUNK_SIZE);
    const persisted = [];

    for (let i = 0; i < batches.length; i++) {
        const batchResults = await Promise.all(batches[i].map(upsertSafely));
        batchResults.forEach(function(product) {
            if (product) persisted.push(product);
        });
    }

    return { products: persisted, marketplaceFailures: failures };
}

// ── Search + persist (cached) ────────────────────────────────────────
//
// Cached by query alone (see searchCacheKey's own comment), shared
// across EVERY caller regardless of who's asking - a guest and a
// logged-in user searching "iphone 16" get the exact same underlying
// fetch, and compare.service.js's own call here (searching by a
// product's title, to find cross-marketplace matches) benefits from the
// same shared cache too.
//
// Deliberately NOT gated on auth/userId, unlike the HTTP-level cache
// this replaced (product.routes.js's old searchCache middleware): that
// design skipped caching ENTIRELY for authenticated requests, because a
// cache HIT at the HTTP layer short-circuited before the controller
// ever ran - and the controller is what records search history. Caching
// HERE instead, one layer down, means every call still returns through
// runSearch() -> the controller -> history gets recorded every time,
// regardless of whether the underlying data came from cache or a fresh
// fetch. Only the expensive part is ever skipped, never the side effect.
async function searchAndPersist(query, options) {
    const key = searchCacheKey(query);

    const { value, fromCache } = await cache.getOrSet(key, config.cacheTtl.search, function() {
        return fetchAndPersist(query, options);
    });

    logger.info('Search and persist completed', {
        query,
        persistedCount: value.products.length,
        marketplaceFailures: value.marketplaceFailures,
        fromCache,
    });

    return value;
}

// ── Single product lookup ───────────────────────────────────────────
async function getProductDetail(productId) {
    const product = await productRepository.findById(productId);
    if (!product) {
        throw ApiError.notFound('Product not found');
    }
    return product;
}

// ── Refresh a single product by its marketplace URL ─────────────────
// Used by the compare-url flow, and reusable later by the price-
// refresher job for a targeted re-check of one specific product.
async function refreshProductByLink(url) {
    const marketplace = adapters.detectMarketplaceFromUrl(url);
    if (!marketplace) {
        throw ApiError.badRequest('Could not detect a supported marketplace from this URL');
    }

    const providerProduct = await adapters.searchByLink(url);
    if (!providerProduct) {
        throw ApiError.badGateway('Could not extract product details from this URL');
    }

    const outcome = await productRepository.upsertFromProviderData(providerProduct);
    return { product: outcome.product, priceChanged: outcome.priceChanged, isNew: outcome.isNew };
}

module.exports = {
    searchAndPersist,
    getProductDetail,
    refreshProductByLink,
};