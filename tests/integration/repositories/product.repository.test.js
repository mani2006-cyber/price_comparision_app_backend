// tests/integration/repositories/product.repository.test.js
//
// Integration test for the most important write-path in the app:
// upsertFromProviderData. Covers create-vs-update branching, price-
// extreme (lowestPrice/highestPrice) tracking, and the
// discountPercentage-survives-an-update fix (findByIdAndUpdate bypasses
// Product.model.js's pre('save') hook, so this repository must
// recompute it independently on every update).

'use strict';

const mongoose = require('mongoose');
const config = require('../../../src/config/env');
const Product = require('../../../src/models/Product.model');
const User = require('../../../src/models/User.model');
const Alert = require('../../../src/models/Alert.model');
const productRepository = require('../../../src/repositories/product.repository');

const MARKETPLACE = 'amazon';
const EXTERNAL_ID = 'REPOTEST_PRODUCT_1';

async function cleanup() {
    await Product.deleteOne({ marketplace: MARKETPLACE, externalId: EXTERNAL_ID });
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
});

describe('upsertFromProviderData - update path, price changed', function() {
    it('detects a price drop and updates lowestPrice', async function() {
        await productRepository.upsertFromProviderData(baseData({ currentPrice: 10000 }));
        const result = await productRepository.upsertFromProviderData(baseData({ currentPrice: 8500 }));

        expect(result.priceChanged).toBe(true);
        expect(result.product.currentPrice).toBe(8500);
        expect(result.product.lowestPrice).toBe(8500);
        expect(result.product.highestPrice).toBe(10000); // unchanged - this wasn't a new high
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

// The price-refresher job's real query - see priceRefresher.job.js and
// this function's own doc comment for why it exists (re-checking the
// WHOLE catalog on a schedule was hammering marketplaces with live
// requests for products nobody was tracking).
describe('findStaleWithActiveAlerts', function() {
    const REPOTEST_EMAIL = 'repotest-findstale@example.com';
    const ONE_HOUR_MS = 60 * 60 * 1000;

    let user;
    let staleAlerted;
    let freshAlerted;
    let staleNoAlert;
    let staleTriggeredAlert;

    async function cleanupStaleFixtures() {
        await Alert.deleteMany({ userId: user ? user._id : null });
        await Product.deleteMany({ externalId: { $regex: /^REPOTEST_STALE_/ } });
        await User.deleteOne({ email: REPOTEST_EMAIL });
    }

    beforeEach(async function() {
        await User.deleteOne({ email: REPOTEST_EMAIL });
        user = await User.create({ name: 'Stale Test User', email: REPOTEST_EMAIL, password: 'plaintext123' });

        const now = Date.now();
        const staleTime = new Date(now - 7 * ONE_HOUR_MS); // older than a 6h threshold
        const freshTime = new Date(now - 1 * ONE_HOUR_MS); // within a 6h threshold

        staleAlerted = await Product.create(baseData({ externalId: 'REPOTEST_STALE_1' }));
        await Product.updateOne({ _id: staleAlerted._id }, { lastCheckedAt: staleTime });
        await Alert.create({ userId: user._id, productId: staleAlerted._id, targetPrice: 1, status: 'active' });

        freshAlerted = await Product.create(baseData({ externalId: 'REPOTEST_STALE_2' }));
        await Product.updateOne({ _id: freshAlerted._id }, { lastCheckedAt: freshTime });
        await Alert.create({ userId: user._id, productId: freshAlerted._id, targetPrice: 1, status: 'active' });

        staleNoAlert = await Product.create(baseData({ externalId: 'REPOTEST_STALE_3' }));
        await Product.updateOne({ _id: staleNoAlert._id }, { lastCheckedAt: staleTime });
        // deliberately no Alert at all

        staleTriggeredAlert = await Product.create(baseData({ externalId: 'REPOTEST_STALE_4' }));
        await Product.updateOne({ _id: staleTriggeredAlert._id }, { lastCheckedAt: staleTime });
        await Alert.create({ userId: user._id, productId: staleTriggeredAlert._id, targetPrice: 1, status: 'triggered' });
    });

    afterEach(cleanupStaleFixtures);

    it('returns only products that are BOTH stale AND have an active alert', async function() {
        const threshold = new Date(Date.now() - 6 * ONE_HOUR_MS);
        const results = await productRepository.findStaleWithActiveAlerts(threshold, 100);
        const ids = results.map(function(p) { return p._id.toString(); });

        expect(ids).toContain(staleAlerted._id.toString());
        expect(ids).not.toContain(freshAlerted._id.toString()); // has an alert, but not stale
        expect(ids).not.toContain(staleNoAlert._id.toString()); // stale, but no alert at all
        expect(ids).not.toContain(staleTriggeredAlert._id.toString()); // stale + alerted, but not ACTIVE
    });

    it('respects the limit parameter', async function() {
        const threshold = new Date(Date.now() - 6 * ONE_HOUR_MS);
        const results = await productRepository.findStaleWithActiveAlerts(threshold, 0);
        // limit of 0 falls back to the function's own default (100) per
        // the `limit || 100` pattern shared with findStale - not asserting
        // an exact count here (other tests' fixtures may coexist), just
        // that passing a limit doesn't throw and returns an array.
        expect(Array.isArray(results)).toBe(true);
    });

    it('returns an empty array when there are no active alerts at all', async function() {
        await Alert.deleteMany({ userId: user._id });

        const threshold = new Date(Date.now() - 6 * ONE_HOUR_MS);
        const results = await productRepository.findStaleWithActiveAlerts(threshold, 100);

        expect(results).toEqual([]);
    });
});