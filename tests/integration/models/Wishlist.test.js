// tests/integration/models/Wishlist.test.js
//
// Integration test for Wishlist.model.js. Confirms the reference-based
// design (File 11): populated product data is always LIVE, never a
// stale snapshot, and duplicate (userId, productId) pairs are rejected.

'use strict';

const mongoose = require('mongoose');
const config = require('../../../src/config/env');
const User = require('../../../src/models/User.model');
const Product = require('../../../src/models/Product.model');
const Wishlist = require('../../../src/models/Wishlist.model');

const TEST_EMAIL = 'modeltest-wishlist@example.com';
const MARKETPLACE = 'amazon';
const EXTERNAL_ID = 'WISHMODELTEST1';

let user;
let product;

beforeAll(async function() {
    await mongoose.connect(config.mongoUri);
});

afterAll(async function() {
    await mongoose.disconnect();
});

beforeEach(async function() {
    await User.deleteMany({ email: TEST_EMAIL });
    await Product.deleteMany({ marketplace: MARKETPLACE, externalId: EXTERNAL_ID });

    user = await User.create({ name: 'Wishlist Test', email: TEST_EMAIL, password: 'plaintext123' });
    product = await Product.create({
        marketplace: MARKETPLACE,
        externalId: EXTERNAL_ID,
        title: 'Test Product For Wishlist',
        currentPrice: 4999,
        rawUrl: 'https://www.amazon.in/dp/' + EXTERNAL_ID,
        fetchedVia: 'scraper',
    });

    await Wishlist.deleteMany({ userId: user._id });
});

describe('Wishlist model', function() {
    it('creates a wishlist entry referencing a user and product', async function() {
        const item = await Wishlist.create({ userId: user._id, productId: product._id });
        expect(item._id).toBeDefined();
        expect(item.userId.toString()).toBe(user._id.toString());
        expect(item.productId.toString()).toBe(product._id.toString());
    });

    it('rejects a duplicate (userId, productId) pair', async function() {
        await Wishlist.create({ userId: user._id, productId: product._id });

        await expect(Wishlist.create({ userId: user._id, productId: product._id })).rejects.toMatchObject({
            code: 11000,
        });
    });

    it('populate() returns live product data, not a stored snapshot', async function() {
        const item = await Wishlist.create({ userId: user._id, productId: product._id });

        const populated = await Wishlist.findById(item._id).populate('productId');
        expect(populated.productId.title).toBe('Test Product For Wishlist');
        expect(populated.productId.currentPrice).toBe(4999);
    });

    it('reflects a price change on the underlying product automatically - no wishlist write needed', async function() {
        const item = await Wishlist.create({ userId: user._id, productId: product._id });

        await Product.updateOne({ _id: product._id }, { currentPrice: 4499 });

        const populated = await Wishlist.findById(item._id).populate('productId');
        expect(populated.productId.currentPrice).toBe(4499);
    });

    it('stores no product fields directly on the wishlist document itself', async function() {
        const item = await Wishlist.create({ userId: user._id, productId: product._id });
        const raw = item.toObject();

        expect(raw.title).toBeUndefined();
        expect(raw.price).toBeUndefined();
        expect(raw.currentPrice).toBeUndefined();
    });
});