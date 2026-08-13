// tests/unit/validators/alert.validators.test.js

'use strict';

const { createAlertBodySchema } = require('../../../src/validators/alert.validators');

describe('createAlertBodySchema', function() {
    it('accepts a valid body with a numeric targetPrice', function() {
        const result = createAlertBodySchema.parse({ productId: 'abc123', targetPrice: 45000 });
        expect(result).toEqual({ productId: 'abc123', targetPrice: 45000 });
    });

    it('coerces a numeric-string targetPrice, matching the old controller\'s Number(...) call', function() {
        const result = createAlertBodySchema.parse({ productId: 'abc123', targetPrice: '45000' });
        expect(result.targetPrice).toBe(45000);
    });

    it('rejects a non-numeric targetPrice', function() {
        expect(function() {
            createAlertBodySchema.parse({ productId: 'abc123', targetPrice: 'not-a-number' });
        }).toThrow("A positive numeric 'targetPrice' is required");
    });

    it('rejects a zero or negative targetPrice', function() {
        expect(function() { createAlertBodySchema.parse({ productId: 'abc123', targetPrice: 0 }); }).toThrow(
            "A positive numeric 'targetPrice' is required"
        );
        expect(function() { createAlertBodySchema.parse({ productId: 'abc123', targetPrice: -100 }); }).toThrow(
            "A positive numeric 'targetPrice' is required"
        );
    });

    it('rejects a missing productId', function() {
        expect(function() { createAlertBodySchema.parse({ targetPrice: 45000 }); }).toThrow(
            "A 'productId' is required"
        );
    });
});
