// src/services/compare.service.js
//
// Rebuilds "paste a URL, find the best cross-marketplace matches"
// (learn/routes/compare.js), generalized from a hardcoded Amazon<->Flipkart
// pair to all active marketplaces. Every result - original AND matches -
// is a persisted Product document, since this reuses product.service.js's
// existing search+persist and refresh paths rather than working with raw
// adapter output.

'use strict';

const config = require('../config/env');
const ApiError = require('../utils/ApiError');
const adapters = require('../adapters');
const productService = require('./product.service');
const { rankByCombinedMatch } = require('../utils/similarity');
const aiComparisonService = require('./aiComparison.service');
const logger = require('../utils/logger');

async function compareByUrl(url) {
    if (!url || typeof url !== 'string') {
        throw ApiError.badRequest("A product 'url' is required");
    }

    const marketplace = adapters.detectMarketplaceFromUrl(url);
    if (!marketplace) {
        // Build the active-marketplaces list defensively - if this call
        // itself ever fails or returns something unexpected, the user
        // should still get a clean 400, not a TypeError while we were
        // constructing the ERROR message for a different problem.
        let activeList = 'amazon, flipkart, myntra, lenskart, nykaa, poorvika, vijaysales';
        try {
            const active = adapters.getActiveMarketplaces();
            if (Array.isArray(active) && active.length > 0) {
                activeList = active.join(', ');
            }
        } catch (err) {
            // Fall through to the hardcoded default above.
        }

        throw ApiError.badRequest('URL not recognized. Supported marketplaces: ' + activeList);
    }

    // ── 1. Fetch + persist the ORIGINAL product ─────────────────────────
    // refreshProductByLink already upserts through product.repository.js,
    // which handles price-change detection and lowestPrice/highestPrice
    // tracking automatically (File 17) - no separate "record this
    // observation" step needed here, unlike the old codebase's
    // fire-and-forget call.
    const originalOutcome = await productService.refreshProductByLink(url);
    const originalProduct = originalOutcome.product;

    // ── 2. Search ALL marketplaces using the original product's title ──
    const searchResult = await productService.searchAndPersist(originalProduct.title);

    // ── 3. Cross-marketplace matches ONLY - never the same platform as the
    // original. This is a price COMPARISON across retailers, not a list of
    // similar products on one site (a same-marketplace "match" is almost
    // always a different variant/model, not a genuine price comparison).
    const candidates = searchResult.products.filter(function(p) {
        return p.marketplace !== originalProduct.marketplace;
    });

    // ── 4. Rank using title + spec + price signals combined - title
    // similarity alone can't tell "128GB" from "256GB" apart, since both
    const ranked = rankByCombinedMatch(originalProduct, candidates);

    // Keep only the SINGLE best-scoring match per marketplace. A scraper
    // commonly returns several rows for one real listing (color/variant
    const bestPerMarketplace = {};
    ranked.forEach(function(item) {
        if (item.similarityScore < config.compare.similarityThreshold) return;
        if (!bestPerMarketplace[item.marketplace]) {
            bestPerMarketplace[item.marketplace] = item;
        }
    });

    const goodMatches = Object.keys(bestPerMarketplace)
        .map(function(marketplace) { return bestPerMarketplace[marketplace]; })
        .sort(function(a, b) { return b.similarityScore - a.similarityScore; })
        .slice(0, config.compare.maxCrossMatches);

    // ── 5. Build final result list: original first-class, then matches,
    // all sorted by price ascending ─────────────────────────────────────
    const allResults = [
        Object.assign({}, originalProduct.toObject(), { isOriginal: true, similarityScore: 1 }),
    ].concat(
        goodMatches.map(function(item) {
            return Object.assign({}, item, {
                isOriginal: false,
                similarityScore: Math.round(item.similarityScore * 100) / 100,
            });
        })
    );

    allResults.sort(function(a, b) { return a.currentPrice - b.currentPrice; });

    // ── 6. Optional AI-generated summary (never blocks/fails the request -
    // see aiComparison.service.js's own comment; null when no API key is
    // configured, no genuine matches were found, or the call fails). ──────
    const aiSummary = await aiComparisonService.generateComparisonSummary(originalProduct, goodMatches);

    logger.info('Compare-url completed', {
        url,
        marketplace,
        candidateCount: candidates.length,
        matchesFound: goodMatches.length,
        aiSummaryGenerated: !!aiSummary,
    });

    return {
        originalUrl: url,
        detectedMarketplace: marketplace,
        matchesFound: goodMatches.length,
        results: allResults,
        marketplaceFailures: searchResult.marketplaceFailures,
        aiSummary: aiSummary,
    };
}

module.exports = { compareByUrl };