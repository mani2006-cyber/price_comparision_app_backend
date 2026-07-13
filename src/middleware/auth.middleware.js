// src/middleware/auth.middleware.js
//
// Verifies the Authorization: Bearer <accessToken> header and attaches
// req.userId. Uses config.accessToken.secret specifically - never the
// refresh secret, which would let a stolen refresh token be used
// directly against protected routes, defeating the short-lived-access-
// token model entirely. Deliberately stateless - no DB check here; only
// the refresh flow touches the database (see auth.service.js).

'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config/env');
const ApiError = require('../utils/ApiError');

function extractToken(req) {
    const header = req.headers.authorization;
    if (!header || header.indexOf('Bearer ') !== 0) {
        return null;
    }
    return header.slice('Bearer '.length).trim();
}

// ── Required auth - throws if missing/invalid ──────────────────────
function requireAuth(req, res, next) {
    const token = extractToken(req);

    if (!token) {
        return next(ApiError.unauthorized('No access token provided'));
    }

    try {
        const decoded = jwt.verify(token, config.accessToken.secret);
        req.userId = decoded.userId;
        next();
    } catch (err) {
        next(ApiError.unauthorized('Invalid or expired access token'));
    }
}

// ── Optional auth - never throws, just may leave req.userId unset ───
// For routes that behave for both guests and logged-in users (e.g.
// search - works for anyone, but records history only if logged in).
function optionalAuth(req, res, next) {
    const token = extractToken(req);

    if (!token) {
        return next(); // no token - proceed as guest, req.userId stays undefined
    }

    try {
        const decoded = jwt.verify(token, config.accessToken.secret);
        req.userId = decoded.userId;
    } catch (err) {
        // An invalid/expired token on an OPTIONAL route is treated the same
        // as no token at all - proceed as guest, don't block the request
        // over a bad token when auth wasn't required in the first place.
    }

    next();
}

module.exports = { requireAuth, optionalAuth };