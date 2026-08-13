// tests/integration/models/PriceHistory.test.js
//
// Integration test for PriceHistory.model.js. Append-only collection -
// confirms chronological sorting works regardless of insertion order,
// and that no Product fields are duplicated onto history rows (the
// design fix over the old codebase, which stored title/source/url on
// every single row).

'use strict';

const mongoose = require('mongoose');
const config = require('../../../src/config/env');
const Product = require('../../../src/models/Product.model');
const PriceHistory = require('../../../src/models/PriceHistory.model');

const MARKETPLACE = 'amazon';
const EXTERNAL_ID = 'PHMODELTEST1';

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
        title: 'Test Product For Price History',
        currentPrice: 60000,
        rawUrl: 'https://www.amazon.in/dp/' + EXTERNAL_ID,
        fetchedVia: 'scraper',
    });

    await PriceHistory.deleteMany({ productId: product._id });
});

describe('PriceHistory model', function() {
    it('sorts oldest-to-newest by recordedAt regardless of insertion order', async function() {
        await PriceHistory.create({ productId: product._id, price: 62000, recordedAt: new Date('2026-01-01') });
        await PriceHistory.create({ productId: product._id, price: 59000, recordedAt: new Date('2026-01-03') });
        await PriceHistory.create({ productId: product._id, price: 60500, recordedAt: new Date('2026-01-02') });

        const history = await PriceHistory.find({ productId: product._id })
            .sort({ recordedAt: 1 })
            .select('price recordedAt');

        expect(history.map(function(h) { return h.price; })).toEqual([62000, 60500, 59000]);
    });

    it('does not store title, source, or url on any history row', async function() {
        const row = await PriceHistory.create({ productId: product._id, price: 60000 });
        const raw = row.toObject();

        expect(raw.title).toBeUndefined();
        expect(raw.source).toBeUndefined();
        expect(raw.url).toBeUndefined();
    });

    it('defaults recordedAt to now when not explicitly provided', async function() {
        const before = Date.now();
        const row = await PriceHistory.create({ productId: product._id, price: 60000 });
        const after = Date.now();

        expect(row.recordedAt.getTime()).toBeGreaterThanOrEqual(before);
        expect(row.recordedAt.getTime()).toBeLessThanOrEqual(after);
    });
});