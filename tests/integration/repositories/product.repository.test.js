// tests/integration/repositories/product.repository.test.js
//
// Integration test for the most important write-path in the app:
// upsertFromProviderData. Covers create-vs-update branching, price-
// extreme tracking, PriceHistory recording on genuine price changes,
// and the discountPercentage-survives-an-update fix (findByIdAndUpdate
// bypasses Product.model.js's pre('save') hook, so this repository must
// recompute it independently on every update).

'use strict';

const mongoose = require('mongoose');
const config = require('../../../src/config/env');
const Product = require('../../../src/models/Product.model');
const PriceHistory = require('../../../src/models/PriceHistory.model');
const productRepository = require('../../../src/repositories/product.repository');

const MARKETPLACE = 'amazon';
const EXTERNAL_ID = 'REPOTEST_PRODUCT_1';

async function cleanup() {
    const existing = await Product.findOne({ marketplace: MARKETPLACE, externalId: EXTERNAL_ID });
    if (existing) {
        await PriceHistory.deleteMany({ productId: existing._id });
        await Product.deleteOne({ _id: existing._id });
    }
}

function baseData(overrides) {
    return Object.assign({
            marketplace: MARKETPLACE,
            externalId: EXTERNAL_ID,
            title: 'Repo Test Product',
            brand: 'TestBrand',
            currentPrice: 10000,
            rawUrl: 'https://www.amazon.in/dp/' + EXTERNAL_ID,
            fetchedVia: 'scraper',
        },
        overrides
    );
}

beforeAll(async function() {
    await mongoose.connect(config.mongoUri);
});

afterAll(async function() {
    await mongoose.disconnect();
});

beforeEach(cleanup);
afterEach(cleanup);

describe('upsertFromProviderData - create path', function() {
    it('creates a new product and initializes price extremes', async function() {
        const result = await productRepository.upsertFromProviderData(baseData());

        expect(result.isNew).toBe(true);
        expect(result.priceChanged).toBe(false);
        expect(result.product.lowestPrice).toBe(10000);
        expect(result.product.highestPrice).toBe(10000);
    });
});

describe('upsertFromProviderData - update path, no price change', function() {
    it('updates the SAME document rather than creating a duplicate', async function() {
        const first = await productRepository.upsertFromProviderData(baseData());
        const second = await productRepository.upsertFromProviderData(baseData());

        expect(second.isNew).toBe(false);
        expect(second.priceChanged).toBe(false);
        expect(second.product._id.toString()).toBe(first.product._id.toString());
    });

    it('does not write a PriceHistory row when the price has not changed', async function() {
        const first = await productRepository.upsertFromProviderData(baseData());
        await productRepository.upsertFromProviderData(baseData());

        const history = await PriceHistory.find({ productId: first.product._id });
        expect(history).toHaveLength(0);
    });
});

describe('upsertFromProviderData - update path, price changed', function() {
    it('detects a price drop, updates lowestPrice, writes a PriceHistory row', async function() {
        await productRepository.upsertFromProviderData(baseData({ currentPrice: 10000 }));
        const result = await productRepository.upsertFromProviderData(baseData({ currentPrice: 8500 }));

        expect(result.priceChanged).toBe(true);
        expect(result.product.currentPrice).toBe(8500);
        expect(result.product.lowestPrice).toBe(8500);
        expect(result.product.highestPrice).toBe(10000); // unchanged - this wasn't a new high

        const history = await PriceHistory.find({ productId: result.product._id });
        expect(history).toHaveLength(1);
        expect(history[0].price).toBe(8500);
    });

    it('detects a price rise, updates highestPrice, leaves lowestPrice alone', async function() {
        await productRepository.upsertFromProviderData(baseData({ currentPrice: 10000 }));
        await productRepository.upsertFromProviderData(baseData({ currentPrice: 8500 }));
        const result = await productRepository.upsertFromProviderData(baseData({ currentPrice: 11000 }));

        expect(result.product.highestPrice).toBe(11000);
        expect(result.product.lowestPrice).toBe(8500); // unchanged - still the lowest ever seen
    });
});

describe('upsertFromProviderData - discountPercentage survives an update (regression test)', function() {
    // findByIdAndUpdate is a QUERY-level operation and does NOT run
    // Product.model.js's pre('save') hook, where discountPercentage
    // normally gets auto-computed. Without the fix in this repository,
    // every update after the first silently overwrote a correct
    // discountPercentage with null.
    it('computes discountPercentage correctly on create', async function() {
        const result = await productRepository.upsertFromProviderData(
            baseData({ currentPrice: 48990, originalPrice: 77990 })
        );
        expect(result.product.discountPercentage).toBeCloseTo(37.2, 1);
    });

    it('recomputes discountPercentage correctly on an UPDATE, not just create', async function() {
        await productRepository.upsertFromProviderData(baseData({ currentPrice: 48990, originalPrice: 77990 }));

        // Second upsert with the SAME price/originalPrice - exactly what a
        // repeat search does, and exactly the case that used to null it out.
        const second = await productRepository.upsertFromProviderData(
            baseData({ currentPrice: 48990, originalPrice: 77990 })
        );

        expect(second.product.discountPercentage).not.toBeNull();
        expect(second.product.discountPercentage).toBeCloseTo(37.2, 1);
    });

    it('recomputes discountPercentage when the price genuinely changes', async function() {
        await productRepository.upsertFromProviderData(baseData({ currentPrice: 48990, originalPrice: 77990 }));
        const third = await productRepository.upsertFromProviderData(
            baseData({ currentPrice: 45000, originalPrice: 77990 })
        );

        expect(third.product.discountPercentage).toBeCloseTo(42.3, 1);
    });
});

describe('findByMarketplaceAndExternalId', function() {
    it('finds the product created by upsertFromProviderData', async function() {
        const created = await productRepository.upsertFromProviderData(baseData());
        const found = await productRepository.findByMarketplaceAndExternalId(MARKETPLACE, EXTERNAL_ID);

        expect(found._id.toString()).toBe(created.product._id.toString());
    });

    it('returns null for a marketplace/externalId combo that does not exist', async function() {
        const found = await productRepository.findByMarketplaceAndExternalId(MARKETPLACE, 'DOES_NOT_EXIST');
        expect(found).toBeNull();
    });
});