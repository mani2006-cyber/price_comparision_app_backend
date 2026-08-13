// src/middleware/errorHandler.js
//
// Centralized error handling. Register notFoundHandler after all routes,
// and errorHandler LAST of all (it must have exactly 4 arguments for
// Express to recognize it as an error-handling middleware).

'use strict';

const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const config = require('../config/env');

// ── 404 — no route matched ──────────────────────────────────────────────
function notFoundHandler(req, res, next) {
    next(ApiError.notFound('Route not found: ' + req.method + ' ' + req.originalUrl));
}

// ── Normalize known non-ApiError error shapes into an ApiError ─────────
// Keeps the main handler below simple — by the time we get there, we
// always have consistent { statusCode, message, details } to work with.
function normalizeError(err) {
    if (err instanceof ApiError) {
        return err;
    }

    // Mongoose: malformed ObjectId, e.g. GET /api/wishlist/not-a-real-id
    if (err.name === 'CastError') {
        return ApiError.badRequest('Invalid identifier: ' + err.value);
    }

    // Mongoose: schema validation failure (required field missing, enum
    // mismatch, etc.) — collect all field messages into `details`.
    if (err.name === 'ValidationError' && err.errors) {
        const details = Object.keys(err.errors).map(function(field) {
            return { field: field, message: err.errors[field].message };
        });
        return ApiError.badRequest('Validation failed', details);
    }

    // Zod: request validation failure from validate.middleware.js (query/
    // body/params schemas in src/validators/). Same shape as the Mongoose
    // branch above — one flat `message` (the first issue's, since that's
    // usually the one a caller most needs to see/matches an existing
    // hand-written message a route relied on) plus every issue in
    // `details` for a client that wants field-level granularity.
    if (err.name === 'ZodError' && Array.isArray(err.issues)) {
        const details = err.issues.map(function(issue) {
            return { field: issue.path.join('.'), message: issue.message };
        });
        const message = (err.issues[0] && err.issues[0].message) || 'Validation failed';
        return ApiError.badRequest(message, details);
    }

    // MongoDB duplicate key error (unique index violation) — same case
    // learn/routes/wishlist.js handled manually with `if (err.code === 11000)`.
    if (err.code === 11000) {
        return ApiError.conflict('A record with this value already exists');
    }

    // JWT errors from jsonwebtoken (expired/invalid token slipping through
    // outside our own auth middleware, e.g. from a future integration).
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
        return ApiError.unauthorized('Invalid or expired token');
    }

    // Truly unexpected — not something we categorized. Treat as a 500 and
    // preserve the original error so the handler below can log it fully.
    const unexpected = ApiError.internal('Something went wrong');
    unexpected.originalError = err;
    return unexpected;
}

// ── Main error handler — MUST have 4 args for Express to treat it as
// error middleware, even though `next` is unused ──────────────────────
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
    const apiError = normalizeError(err);

    // Log every 5xx with full detail; log 4xx at a lower level since those
    // are normal, expected client mistakes, not something to alert on.
    const logPayload = {
        method: req.method,
        path: req.originalUrl,
        statusCode: apiError.statusCode,
    };

    if (apiError.statusCode >= 500) {
        const originalErr = apiError.originalError || err;
        logger.error('Request failed', {
            message: originalErr.message,
            stack: originalErr.stack,
            method: logPayload.method,
            path: logPayload.path,
        });
    } else {
        logger.warn('Request rejected', Object.assign({ message: apiError.message }, logPayload));
    }

    const responseBody = {
        success: false,
        error: apiError.message,
    };

    if (apiError.details) {
        responseBody.details = apiError.details;
    }

    // Only include the stack trace outside production, and only for
    // genuine 500s — never for expected 4xx errors.
    if (!config.isProduction && apiError.statusCode >= 500 && apiError.originalError) {
        responseBody.stack = apiError.originalError.stack;
    }

    res.status(apiError.statusCode).json(responseBody);
}

module.exports = { notFoundHandler, errorHandler };