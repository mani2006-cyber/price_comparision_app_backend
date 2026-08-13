// tests/integration/models/Product.test.js
//
// Integration test for Product.model.js. Covers auto-slug, auto-discount
// calculation, price-extreme initialization, and the inStock/availability
// derivation logic - including the fix from the debugging session where
// availability: 'unknown' was incorrectly forcing inStock to false.

'use strict';

const mongoose = require('mongoose');
const config = require('../../../src/config/env');
const Product = require('../../../src/models/Product.model');

const MARKETPLACE = 'amazon';
const EXTERNAL_IDS = ['PRODTEST1', 'PRODTEST2', 'PRODTEST3', 'PRODTEST4', 'PRODTEST5'];

beforeAll(async function() {
    await mongoose.connect(config.mongoUri);
});

afterAll(async function() {
    await mongoose.disconnect();
});

beforeEach(async function() {
    await Product.deleteMany({ marketplace: MARKETPLACE, externalId: { $in: EXTERNAL_IDS } });
});

function baseProduct(overrides) {
    return Object.assign({
            marketplace: MARKETPLACE,
            externalId: 'PRODTEST1',
            title: 'Test Wireless Headphones',
            currentPrice: 2999,
            rawUrl: 'https://www.amazon.in/dp/PRODTEST1',
            fetchedVia: 'scraper',
        },
        overrides
    );
}

describe('Product model - creation defaults', function() {
    it('auto-generates a slug from title + externalId', async function() {
        const p = await Product.create(baseProduct());
        expect(p.slug).toBe('test-wireless-headphones-prodtest1');
    });

    it('auto-computes discountPercentage when originalPrice and currentPrice are both present', async function() {
        const p = await Product.create(baseProduct({ currentPrice: 2999, originalPrice: 3999 }));
        expect(p.discountPercentage).toBeCloseTo(25.0, 1);
    });

    it('trusts an adapter-supplied discountPercentage instead of overwriting it', async function() {
        const p = await Product.create(baseProduct({ currentPrice: 2999, originalPrice: 3999, discountPercentage: 10 }));
        expect(p.discountPercentage).toBe(10);
    });

    it('initializes lowestPrice and highestPrice to currentPrice on creation', async function() {
        const p = await Product.create(baseProduct({ currentPrice: 2999 }));
        expect(p.lowestPrice).toBe(2999);
        expect(p.highestPrice).toBe(2999);
    });

    it('caps images at 10 and rejects more via validation', async function() {
        await expect(
            Product.create(
                baseProduct({ externalId: 'PRODTEST2', images: new Array(11).fill('https://example.com/x.jpg') })
            )
        ).rejects.toThrow();
    });
});

describe('Product model - inStock/availability derivation', function() {
    it('defaults inStock to true when availability is "unknown" (the fix - not forced false)', async function() {
        const p = await Product.create(baseProduct({ externalId: 'PRODTEST2', availability: 'unknown' }));
        expect(p.inStock).toBe(true);
    });

    it('sets inStock to false when availability is "out_of_stock"', async function() {
        const p = await Product.create(baseProduct({ externalId: 'PRODTEST3', availability: 'out_of_stock' }));
        expect(p.inStock).toBe(false);
    });

    it('sets inStock to true when availability is "in_stock"', async function() {
        const p = await Product.create(baseProduct({ externalId: 'PRODTEST4', availability: 'in_stock' }));
        expect(p.inStock).toBe(true);
    });

    it('preserves an existing inStock value when a later update drops back to "unknown"', async function() {
        const p = await Product.create(baseProduct({ externalId: 'PRODTEST5', availability: 'in_stock' }));
        expect(p.inStock).toBe(true);

        p.availability = 'unknown';
        await p.save();

        expect(p.inStock).toBe(true); // unchanged, not flipped to false
    });
});

describe('Product model - uniqueness', function() {
    it('enforces one product per (marketplace, externalId)', async function() {
        await Product.create(baseProduct());

        await expect(Product.create(baseProduct({ title: 'Duplicate attempt' }))).rejects.toMatchObject({
            code: 11000,
        });
    });

    it('allows the SAME externalId on a DIFFERENT marketplace', async function() {
        await Product.create(baseProduct());
        const other = await Product.create(baseProduct({ marketplace: 'flipkart' }));
        expect(other._id).toBeDefined();

        await Product.deleteOne({ marketplace: 'flipkart', externalId: 'PRODTEST1' });
    });
});

describe('Product model - attributes Map', function() {
    it('stores and retrieves attributes as a queryable Map', async function() {
        const p = await Product.create(
            baseProduct({ attributes: { Color: 'Black', Connectivity: 'Bluetooth 5.0' } })
        );
        expect(p.attributes.get('Color')).toBe('Black');
        expect(p.attributes.get('Connectivity')).toBe('Bluetooth 5.0');
    });
});

// Regression test: adapters/index.js and provider.interface.js's own
// VALID_MARKETPLACES list were updated to add nykaa/poorvika/vijaysales,
// but this schema's separate MARKETPLACES enum was NOT - so every search
// result from those three adapters was fetched successfully and then
// silently dropped at persistence with "marketplace: `poorvika` is not
// a valid enum value", never surfacing in the API response at all. This
// pins the fix so it can't silently regress again.
describe('Product model - marketplace enum', function() {
    const NEW_MARKETPLACES = ['nykaa', 'poorvika', 'vijaysales'];

    afterEach(async function() {
        await Product.deleteMany({ marketplace: { $in: NEW_MARKETPLACES }, externalId: { $in: EXTERNAL_IDS } });
    });

    it.each(NEW_MARKETPLACES)('accepts "%s" as a valid marketplace', async function(marketplace) {
        const p = await Product.create(baseProduct({ marketplace, externalId: 'PRODTEST1' }));
        expect(p.marketplace).toBe(marketplace);
    });

    it('still rejects an unrecognized marketplace', async function() {
        await expect(Product.create(baseProduct({ marketplace: 'not-a-real-marketplace' }))).rejects.toMatchObject({
            name: 'ValidationError',
        });
    });
});