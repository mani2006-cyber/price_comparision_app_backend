// tests/unit/validators/product.validators.test.js
//
// Unit tests for the Zod schemas themselves, independent of the
// validate.middleware.js plumbing or the Express route.

'use strict';

const { searchQuerySchema, compareUrlBodySchema } = require('../../../src/validators/product.validators');

describe('searchQuerySchema', function() {
    it('accepts a minimal valid query (q only)', function() {
        const result = searchQuerySchema.parse({ q: 'laptop' });
        expect(result).toEqual({ q: 'laptop' });
    });

    it('trims q', function() {
        expect(searchQuerySchema.parse({ q: '  laptop  ' }).q).toBe('laptop');
    });

    it('rejects a missing q with a message containing \'q\' (matches product.controller.js\'s pre-existing wording)', function() {
        expect(function() { searchQuerySchema.parse({}); }).toThrow(/'q'/);
    });

    it('rejects a whitespace-only q the same way as a missing one', function() {
        expect(function() { searchQuerySchema.parse({ q: '   ' }); }).toThrow(/'q'/);
    });

    it.each(['price_asc', 'price_desc', 'rating'])('accepts sortBy=%s', function(sortBy) {
        expect(searchQuerySchema.parse({ q: 'x', sortBy }).sortBy).toBe(sortBy);
    });

    it('rejects an unrecognized sortBy value', function() {
        expect(function() { searchQuerySchema.parse({ q: 'x', sortBy: 'bogus' }); }).toThrow();
    });

    it('leaves sortBy/platform undefined when omitted (both optional)', function() {
        const result = searchQuerySchema.parse({ q: 'x' });
        expect(result.sortBy).toBeUndefined();
        expect(result.platform).toBeUndefined();
    });

    it('strips unknown keys rather than rejecting the whole request over them', function() {
        const result = searchQuerySchema.parse({ q: 'x', unexpectedField: 'zzz' });
        expect(result).not.toHaveProperty('unexpectedField');
    });

    it('coerces page/limit from query-string values to numbers', function() {
        const result = searchQuerySchema.parse({ q: 'x', page: '2', limit: '10' });
        expect(result.page).toBe(2);
        expect(result.limit).toBe(10);
    });

    it('leaves page/limit undefined when omitted (both optional)', function() {
        const result = searchQuerySchema.parse({ q: 'x' });
        expect(result.page).toBeUndefined();
        expect(result.limit).toBeUndefined();
    });

    it('rejects page below 1', function() {
        expect(function() { searchQuerySchema.parse({ q: 'x', page: '0' }); }).toThrow();
    });

    it('rejects a non-integer page', function() {
        expect(function() { searchQuerySchema.parse({ q: 'x', page: '1.5' }); }).toThrow();
    });

    it('rejects a limit above the configured cap', function() {
        expect(function() { searchQuerySchema.parse({ q: 'x', limit: '999' }); }).toThrow();
    });
});

describe('compareUrlBodySchema', function() {
    it('accepts a well-formed https url', function() {
        const result = compareUrlBodySchema.parse({ url: 'https://www.amazon.in/dp/B0ABCDEFG' });
        expect(result.url).toBe('https://www.amazon.in/dp/B0ABCDEFG');
    });

    it('rejects a missing url', function() {
        expect(function() { compareUrlBodySchema.parse({}); }).toThrow(/'url'/);
    });

    it('rejects a non-url string', function() {
        expect(function() { compareUrlBodySchema.parse({ url: 'not a url' }); }).toThrow();
    });

    it('trims surrounding whitespace before validating url format', function() {
        const result = compareUrlBodySchema.parse({ url: '  https://example.com  ' });
        expect(result.url).toBe('https://example.com');
    });
});
