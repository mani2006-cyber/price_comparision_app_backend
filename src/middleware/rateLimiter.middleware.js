// src/middleware/rateLimiter.middleware.js
//
// Shared rate-limiter factory. apiLimiter is the default, app-wide
// limiter (used in app.js). createLimiter() is for any route needing
// its own stricter numbers - auth.routes.js already has an inline
// example of this pattern; new routes needing custom limits should use
// this factory instead of repeating that pattern inline again.

'use strict';

const rateLimit = require('express-rate-limit');
const config = require('../config/env');

function createLimiter(options) {
    return rateLimit({
        windowMs: options.windowMs,
        max: options.max,
        message: { success: false, error: options.message || 'Too many requests, please try again later' },
        standardHeaders: true,
        legacyHeaders: false,
    });
}

// The default, app-wide limiter - applied globally in app.js.
const apiLimiter = createLimiter({
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.max,
    message: 'Too many requests, please try again later',
});

module.exports = { apiLimiter, createLimiter };