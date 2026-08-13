// tests/unit/validators/wishlist.validators.test.js

'use strict';

const { addWishlistItemBodySchema } = require('../../../src/validators/wishlist.validators');

describe('addWishlistItemBodySchema', function() {
    it('accepts productId alone (notes is optional)', function() {
        const result = addWishlistItemBodySchema.parse({ productId: 'abc123' });
        expect(result).toEqual({ productId: 'abc123' });
    });

    it('accepts productId + notes', function() {
        const result = addWishlistItemBodySchema.parse({ productId: 'abc123', notes: 'gift idea' });
        expect(result.notes).toBe('gift idea');
    });

    it('rejects a missing productId', function() {
        expect(function() { addWishlistItemBodySchema.parse({}); }).toThrow("A 'productId' is required");
    });

    it('rejects a blank productId', function() {
        expect(function() { addWishlistItemBodySchema.parse({ productId: '   ' }); }).toThrow(
            "A 'productId' is required"
        );
    });
});
