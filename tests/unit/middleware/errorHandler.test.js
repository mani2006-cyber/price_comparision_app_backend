// tests/unit/middleware/errorHandler.test.js
//
// Unit tests for errorHandler.js's normalizeError() branches, exercised
// through the real middleware function with fake req/res/next objects.
// Covers the new ZodError branch (added alongside validate.middleware.js)
// plus the pre-existing branches, so a future change to one can't
// silently break another.

'use strict';

const { z } = require('zod');
const { notFoundHandler, errorHandler } = require('../../../src/middleware/errorHandler');
const ApiError = require('../../../src/utils/ApiError');

function fakeRes() {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
}

function fakeReq() {
    return { method: 'GET', originalUrl: '/api/search' };
}

describe('notFoundHandler', function() {
    it('calls next with a 404 ApiError naming the method and path', function() {
        const req = { method: 'GET', originalUrl: '/api/nonexistent' };
        const next = jest.fn();

        notFoundHandler(req, {}, next);

        const err = next.mock.calls[0][0];
        expect(err).toBeInstanceOf(ApiError);
        expect(err.statusCode).toBe(404);
        expect(err.message).toContain('GET /api/nonexistent');
    });
});

describe('errorHandler', function() {
    it('passes an ApiError straight through with its own statusCode/message', function() {
        const res = fakeRes();
        errorHandler(ApiError.badRequest('Bad input'), fakeReq(), res, jest.fn());

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, error: 'Bad input' }));
    });

    it('includes ApiError.details in the response when present', function() {
        const res = fakeRes();
        errorHandler(ApiError.badRequest('Bad input', [{ field: 'q', message: 'required' }]), fakeReq(), res, jest.fn());

        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ details: [{ field: 'q', message: 'required' }] }));
    });

    it('maps a Mongoose CastError to 400', function() {
        const res = fakeRes();
        const castErr = Object.assign(new Error('Cast to ObjectId failed'), { name: 'CastError', value: 'bogus-id' });

        errorHandler(castErr, fakeReq(), res, jest.fn());

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('bogus-id') }));
    });

    it('maps a Mongoose ValidationError to 400 with per-field details', function() {
        const res = fakeRes();
        const validationErr = Object.assign(new Error('Validation failed'), {
            name: 'ValidationError',
            errors: { marketplace: { message: '`bogus` is not a valid enum value' } },
        });

        errorHandler(validationErr, fakeReq(), res, jest.fn());

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            details: [{ field: 'marketplace', message: '`bogus` is not a valid enum value' }],
        }));
    });

    it('maps a MongoDB duplicate-key error (code 11000) to 409', function() {
        const res = fakeRes();
        const dupErr = Object.assign(new Error('duplicate key'), { code: 11000 });

        errorHandler(dupErr, fakeReq(), res, jest.fn());

        expect(res.status).toHaveBeenCalledWith(409);
    });

    it('maps a JsonWebTokenError to 401', function() {
        const res = fakeRes();
        const jwtErr = Object.assign(new Error('invalid signature'), { name: 'JsonWebTokenError' });

        errorHandler(jwtErr, fakeReq(), res, jest.fn());

        expect(res.status).toHaveBeenCalledWith(401);
    });

    it('maps an unrecognized error to a generic 500 without leaking its message', function() {
        const res = fakeRes();
        errorHandler(new Error('some internal detail'), fakeReq(), res, jest.fn());

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Something went wrong' }));
    });

    // ── ZodError branch (added for validate.middleware.js) ─────────────
    describe('ZodError handling', function() {
        function zodErrorFor(schema, input) {
            try {
                schema.parse(input);
            } catch (err) {
                return err;
            }
            throw new Error('expected schema.parse to throw');
        }

        it('maps a ZodError to 400, using the first issue\'s message as the top-level error', function() {
            const schema = z.object({ q: z.string("A search query 'q' is required") });
            const err = zodErrorFor(schema, {});
            const res = fakeRes();

            errorHandler(err, fakeReq(), res, jest.fn());

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                success: false,
                error: "A search query 'q' is required",
            }));
        });

        it('includes every issue in details, with dotted field paths for nested schemas', function() {
            const schema = z.object({ a: z.object({ b: z.string().min(1) }) });
            const err = zodErrorFor(schema, { a: { b: '' } });
            const res = fakeRes();

            errorHandler(err, fakeReq(), res, jest.fn());

            const body = res.json.mock.calls[0][0];
            expect(body.details).toEqual(
                expect.arrayContaining([expect.objectContaining({ field: 'a.b' })])
            );
        });

        it('logs the rejection at warn level (4xx), not error level, matching every other 4xx branch', function() {
            const logger = require('../../../src/utils/logger');
            const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(function() {});
            const errorSpy = jest.spyOn(logger, 'error').mockImplementation(function() {});

            const schema = z.object({ q: z.string().min(1) });
            const err = zodErrorFor(schema, {});

            errorHandler(err, fakeReq(), fakeRes(), jest.fn());

            expect(warnSpy).toHaveBeenCalled();
            expect(errorSpy).not.toHaveBeenCalled();

            warnSpy.mockRestore();
            errorSpy.mockRestore();
        });
    });
});
