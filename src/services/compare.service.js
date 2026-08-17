// src/services/compare.service.js
//
// Rebuilds "paste a URL, find the best cross-marketplace matches"
// (learn/routes/compare.js), generalized from a hardcoded Amazon<->Flipkart
// pair to all active marketplaces. Every result - original AND matches -
// is a persisted Product document, since this reuses product.service.js's
// existing search+persist and refresh paths rather than working with raw
// adapter output.
//
// Caching lives HERE, not at the HTTP layer (product.routes.js no longer
// has a compareCache middleware) - same move product.service.js's
// searchAndPersist already made, for the same reason: result.similarProducts
// is now PAGINATED (page/limit), and an HTTP-level whole-response cache
// keyed on the URL alone would freeze whichever page got requested FIRST
// and serve that exact page to every caller for the rest of the TTL,
// regardless of what page they actually asked for. Splitting into
// computeComparison() (the expensive part - live search, matching, the
// AI summary call - cached by URL alone) and compareByUrl() (always
// runs, paginates similarProducts fresh on every call, cache hit or not)
// keeps the expensive work shared while pagination stays correct.

'use strict';

const config = require('../config/env');
const cache = require('../utils/cache');
const ApiError = require('../utils/ApiError');
const adapters = require('../adapters');
const productService = require('./product.service');
const { rankByCombinedMatch, rankBySimilarity } = require('../utils/similarity');
const aiComparisonService = require('./aiComparison.service');
const logger = require('../utils/logger');

const DEFAULT_PAGE = 1;

function compareCacheKey(url) {
    return 'compare:' + String(url).trim();
}

// The expensive part: live marketplace search, cross-marketplace
// matching, the full similar-products pool, and the AI summary call.
// Cached by URL alone - compareByUrl below paginates result.
// similarProductsPool AFTER this returns (cached or fresh), so a cache
// hit still gets correct, fresh-per-request pagination instead of
// replaying whatever page happened to be requested first.
async function computeComparison(url, marketplace) {
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
        .map(function(mp) { return bestPerMarketplace[mp]; })
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

    // ── 6. Similar products POOL - related items, ANY marketplace
    // including the same one as the original (unlike results[] above,
    // which is deliberately cross-marketplace-only). "Similar" here means
    // title similarity alone, no price gate and no spec-match requirement -
    // a different color/storage variant, or a related accessory, is a
    // perfectly good browsing suggestion even though it would be a BAD
    // price-comparison match (which is exactly why results[] excludes
    // it). Never a price claim, so it's kept entirely separate from
    // results[] rather than merged into it. This is the FULL pool (up to
    // config.compare.maxSimilarProducts) - compareByUrl paginates it,
    // this function just computes and caches it.
    const usedIds = {};
    allResults.forEach(function(r) { usedIds[String(r._id)] = true; });
    const similarCandidates = searchResult.products.filter(function(p) {
        return !usedIds[String(p._id)];
    });
    const similarProductsPool = rankBySimilarity(originalProduct.title, similarCandidates)
        .filter(function(p) { return p.similarityScore >= config.compare.minTitleSimilarity; })
        .slice(0, config.compare.maxSimilarProducts)
        .map(function(p) {
            return Object.assign({}, p, { similarityScore: Math.round(p.similarityScore * 100) / 100 });
        });

    // ── 7. Optional AI-generated summary (never blocks/fails the request -
    // see aiComparison.service.js's own comment; null when no API key is
    // configured, no genuine matches were found, or the call fails). ──────
    const aiSummary = await aiComparisonService.generateComparisonSummary(originalProduct, goodMatches);

    logger.info('Compare-url computed', {
        url,
        marketplace,
        candidateCount: candidates.length,
        matchesFound: goodMatches.length,
        similarProductsPoolSize: similarProductsPool.length,
        aiSummaryGenerated: !!aiSummary,
    });

    return {
        matchesFound: goodMatches.length,
        results: allResults,
        similarProductsPool: similarProductsPool,
        marketplaceFailures: searchResult.marketplaceFailures,
        aiSummary: aiSummary,
    };
}

async function compareByUrl(url, options) {
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

    const { value: computed } = await cache.getOrSet(compareCacheKey(url), config.cacheTtl.compare, function() {
        return computeComparison(url, marketplace);
    });

    // Pagination over the already-computed (possibly cached) pool -
    // always runs, cache hit or miss, so it's never stale.
    const page = (options && options.page) || DEFAULT_PAGE;
    const limit = (options && options.limit) || config.compare.similarProductsDefaultLimit;
    const start = (page - 1) * limit;
    const similarProducts = computed.similarProductsPool.slice(start, start + limit);

    return {
        originalUrl: url,
        detectedMarketplace: marketplace,
        matchesFound: computed.matchesFound,
        results: computed.results,
        similarProducts: similarProducts,
        similarProductsPage: page,
        similarProductsLimit: limit,
        similarProductsTotal: computed.similarProductsPool.length,
        similarProductsTotalPages: Math.ceil(computed.similarProductsPool.length / limit) || 0,
        marketplaceFailures: computed.marketplaceFailures,
        aiSummary: computed.aiSummary,
    };
}

module.exports = { compareByUrl };
