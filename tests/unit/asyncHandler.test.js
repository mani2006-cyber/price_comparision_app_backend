// tests/unit/asyncHandler.test.js
//
// Pure unit tests for src/utils/asyncHandler.js. Uses fake req/res/next
// objects rather than a real Express app - asyncHandler only needs to
// see it's dealing with the standard three-argument shape.

'use strict';

const asyncHandler = require('../../src/utils/asyncHandler');
const ApiError = require('../../src/utils/ApiError');

function createMockRes() {
    return {
        statusCode: null,
        body: null,
        status: function(code) {
            this.statusCode = code;
            return this;
        },
        json: function(payload) {
            this.body = payload;
            return this;
        },
    };
}

describe('asyncHandler', function() {
    it('calls the wrapped function with req, res, next', async function() {
        const req = {};
        const res = createMockRes();
        const next = jest.fn();
        let calledWith = null;

        const handler = asyncHandler(async function(r, s, n) {
            calledWith = { r, s, n };
            s.status(200).json({ ok: true });
        });

        await handler(req, res, next);

        expect(calledWith.r).toBe(req);
        expect(calledWith.s).toBe(res);
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ ok: true });
        expect(next).not.toHaveBeenCalled();
    });

    it('forwards a thrown ApiError to next(), never leaves the request hanging', async function() {
        const req = {};
        const res = createMockRes();
        const next = jest.fn();

        const handler = asyncHandler(async function() {
            throw ApiError.badRequest('bad input from async handler');
        });

        await handler(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        const errArg = next.mock.calls[0][0];
        expect(errArg).toBeInstanceOf(ApiError);
        expect(errArg.statusCode).toBe(400);
    });

    it('forwards a genuine unexpected error (e.g. a TypeError) to next(), not just ApiErrors', async function() {
        const req = {};
        const res = createMockRes();
        const next = jest.fn();

        const handler = asyncHandler(async function() {
            const x = null;
            return x.someProperty; // real bug - throws TypeError
        });

        await handler(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(next.mock.calls[0][0]).toBeInstanceOf(TypeError);
    });

    it('handles a synchronous throw inside the wrapped function too, not just rejected promises', async function() {
        const req = {};
        const res = createMockRes();
        const next = jest.fn();

        // Not an async function - throws synchronously rather than
        // returning a rejected promise. asyncHandler's try/catch around
        // Promise.resolve(fn(...)) exists specifically for this case.
        const handler = asyncHandler(function() {
            throw ApiError.internal('sync throw');
        });

        await handler(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(next.mock.calls[0][0].statusCode).toBe(500);
    });
});