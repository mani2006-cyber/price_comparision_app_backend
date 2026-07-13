// src/utils/ApiError.js
//
// Structured error class for all *expected* application errors — bad
// input, missing resources, auth failures, conflicts, etc. Throw these
// from controllers/services; the central error-handling middleware
// (src/middleware/errorHandler.js) catches them and formats the response.
//
// Errors that are NOT an instance of ApiError are treated as unexpected
// bugs by that middleware — logged with full detail and returned to the
// client as a generic 500, never leaking internals.

'use strict';

class ApiError extends Error {
    constructor(statusCode, message, details) {
        super(message);

        this.name = 'ApiError';
        this.statusCode = statusCode;

        // Optional extra structured info (e.g. field-level validation errors).
        // Kept separate from `message` so the middleware can decide whether
        // to expose it, without every call site needing to know that detail.
        this.details = details === undefined ? null : details;

        // isOperational marks this as a "known, handled" error type, as
        // opposed to a programming bug. Useful if we ever want process-level
        // monitoring (e.g. alerting) to treat the two differently.
        this.isOperational = true;

        Error.captureStackTrace(this, this.constructor);
    }

    static badRequest(message, details) {
        return new ApiError(400, message || 'Bad request', details);
    }

    static unauthorized(message) {
        return new ApiError(401, message || 'Unauthorized');
    }

    static forbidden(message) {
        return new ApiError(403, message || 'Forbidden');
    }

    static notFound(message) {
        return new ApiError(404, message || 'Not found');
    }

    static conflict(message) {
        return new ApiError(409, message || 'Conflict');
    }

    static tooManyRequests(message) {
        return new ApiError(429, message || 'Too many requests');
    }

    static internal(message) {
        return new ApiError(500, message || 'Internal server error');
    }

    static badGateway(message) {
        // Used specifically for "we reached out to something external
        // (a scraper target, a third-party API) and it failed" — this is
        // how routes/compare.js's "Could not extract product details" case
        // will be represented, for example.
        return new ApiError(502, message || 'Upstream request failed');
    }
}

module.exports = ApiError;