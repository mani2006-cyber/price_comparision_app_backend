// tests/unit/middleware/validate.middleware.test.js
//
// Unit tests for validate.middleware.js in isolation - fake req/res/next
// objects, no real Express app or HTTP involved (that integration is
// covered separately in tests/integration/routes/product.routes.test.js).

'use strict';

const { z } = require('zod');
const validate = require('../../../src/middleware/validate.middleware');

function fakeReq(overrides) {
    return Object.assign({ query: {}, body: {}, params: {} }, overrides);
}

describe('validate middleware', function() {
    it('replaces req.query with the schema\'s parsed output and calls next() with no error', function() {
        const schema = z.object({ q: z.string().trim().min(1) });
        const middleware = validate({ query: schema });
        const req = fakeReq({ query: { q: '  laptop  ' } });
        const next = jest.fn();

        middleware(req, {}, next);

        expect(next).toHaveBeenCalledWith(); // called with no arguments = success
        expect(req.query).toEqual({ q: 'laptop' }); // trimmed
    });

    it('calls next(err) with the raw ZodError when validation fails, without touching req.query', function() {
        const schema = z.object({ q: z.string().min(1) });
        const middleware = validate({ query: schema });
        const req = fakeReq({ query: {} });
        const next = jest.fn();

        middleware(req, {}, next);

        expect(next).toHaveBeenCalledTimes(1);
        const err = next.mock.calls[0][0];
        expect(err.name).toBe('ZodError');
        expect(req.query).toEqual({}); // unchanged - parse() throws before assignment
    });

    it('validates body independently of query', function() {
        const middleware = validate({ body: z.object({ url: z.string().url() }) });
        const req = fakeReq({ body: { url: 'https://example.com' } });
        const next = jest.fn();

        middleware(req, {}, next);

        expect(next).toHaveBeenCalledWith();
        expect(req.body).toEqual({ url: 'https://example.com' });
    });

    it('validates params independently', function() {
        const middleware = validate({ params: z.object({ id: z.string().min(1) }) });
        const req = fakeReq({ params: { id: 'abc123' } });
        const next = jest.fn();

        middleware(req, {}, next);

        expect(next).toHaveBeenCalledWith();
    });

    it('validates multiple schemas together, failing on the first one that rejects', function() {
        const middleware = validate({
            query: z.object({ q: z.string().min(1) }),
            body: z.object({ url: z.string().url() }),
        });
        const req = fakeReq({ query: { q: 'ok' }, body: { url: 'not-a-url' } });
        const next = jest.fn();

        middleware(req, {}, next);

        const err = next.mock.calls[0][0];
        expect(err.name).toBe('ZodError');
        // query was already validated/assigned before body failed.
        expect(req.query).toEqual({ q: 'ok' });
    });

    it('does nothing to a request part with no matching schema key', function() {
        const middleware = validate({ query: z.object({ q: z.string().min(1) }) });
        const req = fakeReq({ query: { q: 'ok' }, body: { anything: 'unchanged' } });
        const next = jest.fn();

        middleware(req, {}, next);

        expect(req.body).toEqual({ anything: 'unchanged' });
    });
});
