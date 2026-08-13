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

// Header-or-query variant, used ONLY by requireAuthForStream below - not
// by requireAuth/optionalAuth, which stay header-only for every other
// route. The browser's native EventSource API (what a client uses to
// consume the SSE endpoint at GET /api/notifications/stream) cannot set
// custom request headers, so the Authorization: Bearer convention this
// app uses everywhere else isn't available for that one route - the
// access token has to travel as a `?token=` query param instead. Query
// strings can leak into proxy/access logs and browser history in a way
// a header does not, so this fallback is scoped as narrowly as possible
// (one dedicated middleware, one route) rather than added to the shared
// extractToken() every other endpoint relies on.
function extractTokenFromHeaderOrQuery(req) {
    const fromHeader = extractToken(req);
    if (fromHeader) {
        return fromHeader;
    }
    if (req.query && typeof req.query.token === 'string' && req.query.token.trim() !== '') {
        return req.query.token.trim();
    }
    return null;
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

// ── Required auth, header OR ?token= query param - see
// extractTokenFromHeaderOrQuery's own comment for why this exists as a
// separate function instead of a flag on requireAuth ─────────────────
function requireAuthForStream(req, res, next) {
    const token = extractTokenFromHeaderOrQuery(req);

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

module.exports = { requireAuth, optionalAuth, requireAuthForStream };