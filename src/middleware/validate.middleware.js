// src/middleware/validate.middleware.js
//
// Generic Express middleware factory: validates req.query/req.body/
// req.params against Zod schemas, and REPLACES each with the schema's
// parsed output (trimmed/coerced/defaulted) so every downstream
// controller/service sees clean, typed input instead of re-checking it
// itself. A failing schema calls next(err) with the raw ZodError -
// errorHandler.js's normalizeError() turns that into a 400 with
// field-level details, the same way it already does for Mongoose's own
// ValidationError, so callers get one consistent error response shape
// regardless of which layer rejected the request.
//
// Usage:
//   router.get('/search', validate({ query: searchQuerySchema }), asyncHandler(controller.search));

'use strict';

function validate(schemas) {
    return function(req, res, next) {
        try {
            if (schemas.query) {
                req.query = schemas.query.parse(req.query);
            }
            if (schemas.body) {
                req.body = schemas.body.parse(req.body);
            }
            if (schemas.params) {
                req.params = schemas.params.parse(req.params);
            }
            next();
        } catch (err) {
            next(err);
        }
    };
}

module.exports = validate;
