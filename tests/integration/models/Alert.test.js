// tests/integration/models/Alert.test.js
//
// Integration test for Alert.model.js. Unlike Wishlist, Alert
// deliberately allows MULTIPLE entries per (userId, productId) - a user
// can watch the same product at several different target prices.

'use strict';

const mongoose = require('mongoose');
const config = require('../../../src/config/env');
const User = require('../../../src/models/User.model');
const Product = require('../../../src/models/Product.model');
const Alert = require('../../../src/models/Alert.model');

const TEST_EMAIL = 'modeltest-alert@example.com';
const MARKETPLACE = 'amazon';
const EXTERNAL_ID = 'ALERTMODELTEST1';

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

    user = await User.create({ name: 'Alert Test', email: TEST_EMAIL, password: 'plaintext123' });
    product = await Product.create({
        marketplace: MARKETPLACE,
        externalId: EXTERNAL_ID,
        title: 'Test Product For Alerts',
        currentPrice: 50000,
        rawUrl: 'https://www.amazon.in/dp/' + EXTERNAL_ID,
        fetchedVia: 'scraper',
    });

    await Alert.deleteMany({ userId: user._id });
});

describe('Alert model', function() {
    it('creates an alert with status defaulting to active', async function() {
        const alert = await Alert.create({ userId: user._id, productId: product._id, targetPrice: 45000 });
        expect(alert.status).toBe('active');
        expect(alert.triggeredAt).toBeNull();
    });

    it('allows MULTIPLE alerts on the same (userId, productId) at different target prices', async function() {
        const alert1 = await Alert.create({ userId: user._id, productId: product._id, targetPrice: 45000 });
        const alert2 = await Alert.create({ userId: user._id, productId: product._id, targetPrice: 40000 });

        expect(alert1._id).toBeDefined();
        expect(alert2._id).toBeDefined();
    });

    it('rejects a non-positive targetPrice', async function() {
        await expect(
            Alert.create({ userId: user._id, productId: product._id, targetPrice: 0 })
        ).rejects.toThrow();

        await expect(
            Alert.create({ userId: user._id, productId: product._id, targetPrice: -100 })
        ).rejects.toThrow();
    });

    it('supports the active -> triggered status transition with triggeredAt/triggeredAtPrice', async function() {
        const alert = await Alert.create({ userId: user._id, productId: product._id, targetPrice: 45000 });

        alert.status = 'triggered';
        alert.triggeredAt = new Date();
        alert.triggeredAtPrice = 44500;
        await alert.save();

        const reloaded = await Alert.findById(alert._id);
        expect(reloaded.status).toBe('triggered');
        expect(reloaded.triggeredAtPrice).toBe(44500);
        expect(reloaded.triggeredAt).not.toBeNull();
    });

    it('finding active alerts for a product excludes triggered ones', async function() {
        const alert1 = await Alert.create({ userId: user._id, productId: product._id, targetPrice: 45000 });
        await Alert.create({ userId: user._id, productId: product._id, targetPrice: 40000 });

        alert1.status = 'triggered';
        await alert1.save();

        const stillActive = await Alert.find({ productId: product._id, status: 'active' });
        expect(stillActive).toHaveLength(1);
        expect(stillActive[0].targetPrice).toBe(40000);
    });
});