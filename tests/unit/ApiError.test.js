// tests/unit/ApiError.test.js
//
// Pure unit tests for src/utils/ApiError.js - no database, no Express.

'use strict';

const ApiError = require('../../src/utils/ApiError');

describe('ApiError constructor', function() {
    it('sets statusCode, message, and isOperational', function() {
        const err = new ApiError(400, 'Bad input');
        expect(err.statusCode).toBe(400);
        expect(err.message).toBe('Bad input');
        expect(err.isOperational).toBe(true);
    });

    it('is a genuine instance of Error', function() {
        const err = new ApiError(404, 'Not found');
        expect(err instanceof Error).toBe(true);
    });

    it('defaults details to null when not provided', function() {
        const err = new ApiError(400, 'x');
        expect(err.details).toBeNull();
    });

    it('stores details when provided', function() {
        const err = new ApiError(400, 'x', { field: 'email' });
        expect(err.details).toEqual({ field: 'email' });
    });

    it('captures a stack trace', function() {
        const err = new ApiError(500, 'x');
        expect(err.stack).toBeDefined();
    });
});

describe('static factory methods', function() {
    it('badRequest -> 400', function() {
        const err = ApiError.badRequest('Missing field');
        expect(err.statusCode).toBe(400);
        expect(err.message).toBe('Missing field');
    });

    it('badRequest uses a default message when none given', function() {
        expect(ApiError.badRequest().message).toBe('Bad request');
    });

    it('unauthorized -> 401', function() {
        expect(ApiError.unauthorized('bad creds').statusCode).toBe(401);
    });

    it('forbidden -> 403', function() {
        expect(ApiError.forbidden().statusCode).toBe(403);
    });

    it('notFound -> 404', function() {
        expect(ApiError.notFound('Item not found').statusCode).toBe(404);
    });

    it('conflict -> 409', function() {
        expect(ApiError.conflict('Already exists').statusCode).toBe(409);
    });

    it('tooManyRequests -> 429', function() {
        expect(ApiError.tooManyRequests().statusCode).toBe(429);
    });

    it('internal -> 500', function() {
        expect(ApiError.internal().statusCode).toBe(500);
    });

    it('badGateway -> 502', function() {
        expect(ApiError.badGateway('Upstream failed').statusCode).toBe(502);
    });

    it('every factory method returns a genuine ApiError instance', function() {
        expect(ApiError.notFound()).toBeInstanceOf(ApiError);
        expect(ApiError.badRequest()).toBeInstanceOf(ApiError);
    });
});

describe('distinguishing ApiError from a plain Error', function() {
    // This is the exact distinction errorHandler.js (File 7) relies on to
    // tell an expected, user-facing error apart from a genuine bug that
    // should be logged in full but never expose its details to the client.
    it('a plain Error is NOT an instance of ApiError', function() {
        const plainError = new Error('some random bug');
        expect(plainError instanceof ApiError).toBe(false);
    });

    it('an ApiError IS an instance of ApiError', function() {
        expect(ApiError.notFound() instanceof ApiError).toBe(true);
    });
});