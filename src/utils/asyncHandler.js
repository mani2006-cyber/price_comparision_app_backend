// src/utils/asyncHandler.js
//
// Wraps an async Express route/controller function so that any rejected
// promise (i.e. any thrown error inside an `async function`) is passed to
// next(err) automatically, landing in src/middleware/errorHandler.js.
//
// Without this, Express 4's routing does NOT catch promise rejections
// from async handlers — an uncaught one just hangs the request forever.
//
// Usage:
//   router.get('/wishlist', requireAuth, asyncHandler(wishlistController.list));

'use strict';

function asyncHandler(fn) {
    return function(req, res, next) {
        // Promise.resolve(...) handles both cases uniformly: if fn is a
        // genuine async function, calling it already returns a promise; if
        // someone accidentally passes a plain sync function that throws,
        // Promise.resolve still lets us funnel the resulting rejection (or
        // synchronous throw, caught by the try/catch below) into next(err)
        // the same way.
        try {
            Promise.resolve(fn(req, res, next)).catch(next);
        } catch (err) {
            next(err);
        }
    };
}

module.exports = asyncHandler;