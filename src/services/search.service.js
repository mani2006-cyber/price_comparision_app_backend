// src/services/search.service.js
//
// Runs a search (via product.service.js) and records it to the user's
// history (if authenticated) using the merge/bump-to-top behavior from
// File 21. History recording failure never fails the search response -
// it's a nice-to-have relative to the results themselves.

'use strict';

const productService = require('./product.service');
const searchHistoryRepository = require('../repositories/searchHistory.repository');
const logger = require('../utils/logger');

// ── Sorting ──────────────────────────────────────────────────────────
// Deliberately a small, separate, pure function - NOT inlined into
// runSearch below. The old codebase had a sort bug that silently no-op'd
// (missing return in the comparator) for a long time before anyone
// noticed, precisely because it was buried inside a larger function.
// Keeping this isolated makes it trivial to unit-test on its own.
function getSortedProducts(products, sortBy) {
    const sorted = products.slice(); // never mutate the input array

    if (sortBy === 'price_asc') {
        sorted.sort(function(a, b) { return a.currentPrice - b.currentPrice; });
    } else if (sortBy === 'price_desc') {
        sorted.sort(function(a, b) { return b.currentPrice - a.currentPrice; });
    } else if (sortBy === 'rating') {
        sorted.sort(function(a, b) {
            const ratingA = (a.rating && a.rating.average) || 0;
            const ratingB = (b.rating && b.rating.average) || 0;
            return ratingB - ratingA;
        });
    }
    // No sortBy, or an unrecognized value: leave in the order adapters
    // returned them (already interleaved by marketplace search relevance).

    return sorted;
}

// ── Run a search, optionally record history ─────────────────────────
async function runSearch(query, userId, options) {
    const searchResult = await productService.searchAndPersist(query, options);

    const sorted = getSortedProducts(searchResult.products, options && options.sortBy);

    if (userId) {
        try {
            await searchHistoryRepository.recordSearch(
                userId,
                query,
                sorted.length,
                (options && options.platform) || null
            );
        } catch (err) {
            // History recording is a nice-to-have relative to the search
            // itself - log and move on, never fail the response over this.
            logger.error('Failed to record search history', { userId, query, message: err.message });
        }
    }

    return {
        products: sorted,
        marketplaceFailures: searchResult.marketplaceFailures,
    };
}

// ── History access (pass-through, kept here so controllers never touch
// repositories directly - see file header comment) ────────────────────
async function getSearchHistory(userId, limit) {
    return searchHistoryRepository.findByUser(userId, limit);
}

async function deleteSearchHistoryItem(entryId, userId) {
    return searchHistoryRepository.removeByIdForUser(entryId, userId);
}

module.exports = {
    runSearch,
    getSortedProducts,
    getSearchHistory,
    deleteSearchHistoryItem,
};