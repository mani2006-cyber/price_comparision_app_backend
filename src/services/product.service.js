// src/services/product.service.js
//
// Wraps adapters/index.js (live marketplace data) + product.repository.js
// (persistence/upsert) together. Every other service that needs product
// data builds on this one - nobody else talks to adapters or the
// product repository directly.

'use strict';

const adapters = require('../adapters');
const productRepository = require('../repositories/product.repository');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

const UPSERT_CHUNK_SIZE = 5;

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

// ── Search + persist ─────────────────────────────────────────────────
async function searchAndPersist(query, options) {
    const { results, failures } = await adapters.searchAllMarketplaces(query, options);

    const batches = chunk(results, UPSERT_CHUNK_SIZE);
    const persisted = [];

    for (let i = 0; i < batches.length; i++) {
        const batchResults = await Promise.all(batches[i].map(upsertSafely));
        batchResults.forEach(function(product) {
            if (product) persisted.push(product);
        });
    }

    logger.info('Search and persist completed', {
        query,
        rawResultCount: results.length,
        persistedCount: persisted.length,
        marketplaceFailures: failures,
    });

    return { products: persisted, marketplaceFailures: failures };
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