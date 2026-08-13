// src/validators/product.validators.js
//
// Zod schemas for product.routes.js's request shapes, used together
// with validate.middleware.js. Kept separate from the controller so the
// "what does a valid request look like" contract is readable in one
// place, independent of the request-handling logic itself.

'use strict';

const { z } = require('zod');

const SORT_BY_VALUES = ['price_asc', 'price_desc', 'rating'];

// GET /api/search - q is the only required field; the exact same
// message is used for BOTH "missing entirely" (a plain object with no
// q key parses q as undefined -> zod's type error) and "present but
// blank/whitespace-only" (.trim() runs before .min(1), so "   " also
// fails this), matching product.controller.js's own pre-existing
// wording so the response text callers/tests already depend on
// ("A search query 'q' is required") doesn't change.
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

module.exports = {
    SORT_BY_VALUES,
    searchQuerySchema,
    compareUrlBodySchema,
};
