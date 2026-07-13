// tests/integration/repositories/priceHistory.repository.test.js
//
// Integration test for priceHistory.repository.js. Note there is
// deliberately no updateById/updateOne tested here - none exists,
// enforcing the append-only convention (File 19). deleteAllForProduct
// is the one intentional exception, for Product-deletion cleanup only.

'use strict';

const mongoose = require('mongoose');
const config = require('../../../src/config/env');
const Product = require('../../../src/models/Product.model');
const priceHistoryRepository = require('../../../src/repositories/priceHistory.repository');

const MARKETPLACE = 'amazon';
const EXTERNAL_ID = 'PHREPOTEST_1';

let product;

beforeAll(async function() {
    await mongoose.connect(config.mongoUri);
});

afterAll(async function() {
    await mongoose.disconnect();
});

beforeEach(async function() {
    await Product.deleteMany({ marketplace: MARKETPLACE, externalId: EXTERNAL_ID });
    product = await Product.create({
        marketplace: MARKETPLACE,
        externalId: EXTERNAL_ID,
        title: 'Price History Repo Test Product',
        currentPrice: 30000,
        rawUrl: 'https://www.amazon.in/dp/' + EXTERNAL_ID,
        fetchedVia: 'scraper',
    });

    await priceHistoryRepository.deleteAllForProduct(product._id);
});

describe('recordPoint + findByProduct', function() {
    it('returns points oldest-to-newest regardless of insertion order', async function() {
        await priceHistoryRepository.recordPoint(product._id, 31000, new Date('2026-02-01'));
        await priceHistoryRepository.recordPoint(product._id, 28500, new Date('2026-02-03'));
        await priceHistoryRepository.recordPoint(product._id, 29900, new Date('2026-02-02'));

        const all = await priceHistoryRepository.findByProduct(product._id);
        expect(all.map(function(h) { return h.price; })).toEqual([31000, 29900, 28500]);
    });

    it('the `since` parameter filters out points before that date', async function() {
        await priceHistoryRepository.recordPoint(product._id, 31000, new Date('2026-02-01'));
        await priceHistoryRepository.recordPoint(product._id, 29900, new Date('2026-02-02'));
        await priceHistoryRepository.recordPoint(product._id, 28500, new Date('2026-02-03'));

        const recentOnly = await priceHistoryRepository.findByProduct(product._id, new Date('2026-02-02'));
        expect(recentOnly).toHaveLength(2);
    });
});

describe('getLatestPrice', function() {
    it('returns only the single most recent point', async function() {
        await priceHistoryRepository.recordPoint(product._id, 31000, new Date('2026-02-01'));
        await priceHistoryRepository.recordPoint(product._id, 28500, new Date('2026-02-03'));

        const latest = await priceHistoryRepository.getLatestPrice(product._id);
        expect(latest.price).toBe(28500);
    });
});

describe('deleteAllForProduct', function() {
    it('removes every history row for a product', async function() {
        await priceHistoryRepository.recordPoint(product._id, 31000);
        await priceHistoryRepository.recordPoint(product._id, 28500);

        const result = await priceHistoryRepository.deleteAllForProduct(product._id);
        expect(result.deletedCount).toBe(2);

        const remaining = await priceHistoryRepository.findByProduct(product._id);
        expect(remaining).toHaveLength(0);
    });
});