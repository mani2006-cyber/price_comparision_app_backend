// src/controllers/product.controller.js
//
// HTTP layer over search.service.js, product.service.js, and
// compare.service.js. Grouped together since all four endpoints here
// are "product discovery" concerns sharing the same thin
// parse-request -> call service -> return JSON pattern.

'use strict';

const ApiError = require('../utils/ApiError');
const searchService = require('../services/search.service');
const productService = require('../services/product.service');
const compareService = require('../services/compare.service');

// ── Search (guest OR authenticated - see optionalAuth in the route) ────
async function search(req, res) {
    const query = req.query.q;
    if (!query || typeof query !== 'string' || query.trim() === '') {
        throw ApiError.badRequest("A search query 'q' is required");
    }

    const options = {
        sortBy: req.query.sortBy || undefined,
        platform: req.query.platform || undefined,
        page: req.query.page,
        limit: req.query.limit,
    };

    // req.userId is set by optionalAuth ONLY if a valid access token was
    // present - undefined for guests, which search.service.js already
    // treats as "don't record history" (File 42).
    const result = await searchService.runSearch(query.trim(), req.userId, options);

    res.status(200).json({
        success: true,
        query: query.trim(),
        // Total across every page, not just this one - see
        // search.service.js's runSearch for why (search history also
        // records against this same total, not the page size).
        resultCount: result.total,
        products: result.products,
        page: result.page,
        limit: result.limit,
        totalPages: result.totalPages,
        marketplaceFailures: result.marketplaceFailures,
    });
}

// ── Product detail ──────────────────────────────────────────────────
async function getProductDetail(req, res) {
    const product = await productService.getProductDetail(req.params.id);
    res.status(200).json({ success: true, product });
}

// ── Compare by URL ──────────────────────────────────────────────────
async function compareUrl(req, res) {
    const url = req.body.url;
    const options = {
        page: req.query.page,
        limit: req.query.limit,
    };
    const result = await compareService.compareByUrl(url, options);
    res.status(200).json({ success: true, result });
}

// ── Search history (requireAuth - see the route) ────────────────────
async function getSearchHistory(req, res) {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : undefined;
    const history = await searchService.getSearchHistory(req.userId, limit);
    res.status(200).json({ success: true, history });
}

async function deleteSearchHistoryItem(req, res) {
    const result = await searchService.deleteSearchHistoryItem(req.params.id, req.userId);
    if (result.deletedCount === 0) {
        throw ApiError.notFound('Search history item not found');
    }
    res.status(200).json({ success: true, message: 'History item deleted' });
}

module.exports = {
    search,
    getProductDetail,
    compareUrl,
    getSearchHistory,
    deleteSearchHistoryItem,
};