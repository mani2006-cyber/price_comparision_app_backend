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

function filterByQuery(products, query) {
    const tokens = String(query || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .split(/\s+/)
        .filter(function(token) { return token.length > 1; });

    if (tokens.length === 0) return products;

    return products.filter(function(product) {
        const fields = [
            product.title,
            product.brand,
            product.category,
            Array.isArray(product.categoryPath) ? product.categoryPath.join(' ') : '',
            Array.isArray(product.keywords) ? product.keywords.join(' ') : '',
        ].filter(Boolean);

        // Keep legacy/incomplete records visible until they have enough
        // product text to make a relevance decision.
        if (fields.length === 0) return true;

        const searchable = fields.join(' ').toLowerCase();
        return tokens.every(function(token) { return searchable.indexOf(token) !== -1; });
    });
}

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
//
// Search returns the complete merged result set from every active marketplace.
// The expensive marketplace fetch remains cached in product.service.js.
async function runSearch(query, userId, options) {
    const searchResult = await productService.searchAndPersist(query, options);

    const filtered = filterByQuery(searchResult.products, query);
    // Marketplace adapters already searched for this query. If their title
    // or category wording differs from the query, do not turn valid results
    // into an empty frontend response.
    const relevant = filtered.length > 0 ? filtered : searchResult.products;
    const sorted = getSortedProducts(relevant, options && options.sortBy);

    // Recorded against the TOTAL count across every page, not just
    // whichever page was requested - "how many results did this search
    // find" shouldn't depend on which page the caller happened to ask for.
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
        total: sorted.length,
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