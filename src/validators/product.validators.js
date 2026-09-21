// src/validators/product.validators.js
//
// Zod schemas for product.routes.js's request shapes, used together
// with validate.middleware.js. Kept separate from the controller so the
// "what does a valid request look like" contract is readable in one
// place, independent of the request-handling logic itself.

'use strict';

const { z } = require('zod');
const config = require('../config/env');

const SORT_BY_VALUES = ['price_asc', 'price_desc', 'rating'];

// GET /api/search - q is the only required field; the exact same
// message is used for BOTH "missing entirely" (a plain object with no
// q key parses q as undefined -> zod's type error) and "present but
// blank/whitespace-only" (.trim() runs before .min(1), so "   " also
// fails this), matching product.controller.js's own pre-existing
// wording so the response text callers/tests already depend on
// ("A search query 'q' is required") doesn't change.
// page/limit arrive as query strings, hence z.coerce.number() (same
// reasoning as alert.validators.js's targetPrice) rather than z.number().
// limit is capped (config.search.maxLimit) so a client can't force an
// unbounded page size through - the underlying multi-marketplace fetch
// this paginates over is already bounded, but the RESPONSE size wasn't.
const searchQuerySchema = z.object({
    q: z.string("A search query 'q' is required").trim().min(1, "A search query 'q' is required"),
    sortBy: z.enum(SORT_BY_VALUES).optional(),
    // Not cross-checked against adapters.getActiveMarketplaces() here -
    // product.service.js doesn't actually filter search results by this
    // value today (it's recorded on search history only), so validating
    // it against a fixed enum would reject a marketplace added later
    // without a matching code change in two places. A non-empty string
    // is enough to catch the obvious mistakes (e.g. "?platform=").
    platform: z.string().trim().min(1).optional(),
    page: z.coerce.number("'page' must be a number").int().min(1).optional(),
    limit: z.coerce.number("'limit' must be a number").int().min(1).max(config.search.maxLimit).optional(),
});

// POST /api/compare-url - a real URL, not just "any non-empty string"
// (an improvement over the previous manual `typeof url === 'string'`
// check in compare.service.js, which accepted "not a url" and only
// failed later at adapters.detectMarketplaceFromUrl).
const compareUrlBodySchema = z.object({
    url: z.string("A product 'url' is required")
        .trim()
        .min(1, "A product 'url' is required")
        .url("A valid product 'url' is required"),
});

// POST /api/compare-url also accepts page/limit as QUERY params (the
// body is reserved for `url`) to paginate result.similarProducts - same
// coerce-from-string pattern as every other paginated query schema here.
const compareUrlQuerySchema = z.object({
    page: z.coerce.number("'page' must be a number").int().min(1).optional(),
    limit: z.coerce.number("'limit' must be a number").int().min(1).max(config.compare.similarProductsMaxLimit).optional(),
});

// GET /api/categories/:category/products - page/limit arrive as query
// strings, hence z.coerce.number() (same reasoning as alert.validators.js's
// targetPrice) rather than z.number(). limit is capped (config.category.maxLimit)
// so a client can't force an unbounded page size through the cache layer.
const categoryProductsQuerySchema = z.object({
    sortBy: z.enum(SORT_BY_VALUES).optional(),
    page: z.coerce.number("'page' must be a number").int().min(1).optional(),
    limit: z.coerce.number("'limit' must be a number").int().min(1).max(config.category.maxLimit).optional(),
});

module.exports = {
    SORT_BY_VALUES,
    searchQuerySchema,
    compareUrlBodySchema,
    compareUrlQuerySchema,
    categoryProductsQuerySchema,
};
