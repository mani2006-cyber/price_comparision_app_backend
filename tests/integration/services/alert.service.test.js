// tests/integration/services/alert.service.test.js
//
// Integration test for alert.service.js. No adapter mocking needed -
// alerts never touch a marketplace. checkAndTriggerAlerts is the
// function the price-refresher job depends on (File 59) - its
// idempotency here is what prevents a user ever being notified twice
// for the same price drop.

'use strict';

const mongoose = require('mongoose');
const config = require('../../../src/config/env');
const User = require('../../../src/models/User.model');
const Product = require('../../../src/models/Product.model');
const Alert = require('../../../src/models/Alert.model');
const Notification = require('../../../src/models/Notification.model');
const alertService = require('../../../src/services/alert.service');

const EMAIL_A = 'svctest-alert-a@example.com';
const EMAIL_B = 'svctest-alert-b@example.com';
const MARKETPLACE = 'amazon';
const EXTERNAL_ID = 'ALERTSVCTEST_1';

let userA;
let userB;
let product;

beforeAll(async function() {
    await mongoose.connect(config.mongoUri);
});

afterAll(async function() {
    await mongoose.disconnect();
});

beforeEach(async function() {
    await User.deleteMany({ email: { $in: [EMAIL_A, EMAIL_B] } });
    await Product.deleteMany({ marketplace: MARKETPLACE, externalId: EXTERNAL_ID });

    userA = await User.create({ name: 'User A', email: EMAIL_A, password: 'plaintext123' });
    userB = await User.create({ name: 'User B', email: EMAIL_B, password: 'plaintext123' });
    product = await Product.create({
        marketplace: MARKETPLACE,
        externalId: EXTERNAL_ID,
        title: 'Alert Service Test Product',
        currentPrice: 50000,
        rawUrl: 'https://www.amazon.in/dp/' + EXTERNAL_ID,
        fetchedVia: 'scraper',
    });

    await Alert.deleteMany({ userId: { $in: [userA._id, userB._id] } });
    await Notification.deleteMany({ userId: { $in: [userA._id, userB._id] } });
});

describe('createAlert', function() {
    it('creates an alert when targetPrice is below the current price', async function() {
        const alert = await alertService.createAlert(userA._id, product._id, 45000);
        expect(alert._id).toBeDefined();
    });

    it('rejects a targetPrice at or above the current price', async function() {
        await expect(alertService.createAlert(userA._id, product._id, 60000)).rejects.toMatchObject({
            statusCode: 400,
        });
        await expect(alertService.createAlert(userA._id, product._id, 50000)).rejects.toMatchObject({
            statusCode: 400,
        });
    });

    it('rejects a nonexistent product with a 404', async function() {
        await expect(alertService.createAlert(userA._id, '000000000000000000000000', 1000)).rejects.toMatchObject({
            statusCode: 404,
        });
    });
});

describe('checkAndTriggerAlerts', function() {
    it('triggers alerts whose target has been met and creates a notification for each', async function() {
        await alertService.createAlert(userA._id, product._id, 45000);
        await alertService.createAlert(userA._id, product._id, 40000); // not met at 44000

        const triggered = await alertService.checkAndTriggerAlerts(product._id, 44000, product.title);

        expect(triggered).toHaveLength(1);
        expect(triggered[0].targetPrice).toBe(45000);

        const notifications = await Notification.find({ userId: userA._id });
        expect(notifications).toHaveLength(1);
        expect(notifications[0].message).toContain('44000');
    });

    it('does NOT re-trigger or re-notify on a repeat check at the same price (idempotent)', async function() {
        await alertService.createAlert(userA._id, product._id, 45000);

        await alertService.checkAndTriggerAlerts(product._id, 44000, product.title);
        const secondCheck = await alertService.checkAndTriggerAlerts(product._id, 44000, product.title);

        expect(secondCheck).toHaveLength(0);

        const notifications = await Notification.find({ userId: userA._id });
        expect(notifications).toHaveLength(1); // still just the one
    });

    it('returns an empty array when no alerts are met', async function() {
        await alertService.createAlert(userA._id, product._id, 30000);

        const triggered = await alertService.checkAndTriggerAlerts(product._id, 44000, product.title);
        expect(triggered).toHaveLength(0);
    });
});

describe('cancelAlert - ownership enforcement', function() {
    it('rejects cancellation by a different user with a 404', async function() {
        const alert = await alertService.createAlert(userA._id, product._id, 45000);

        await expect(alertService.cancelAlert(alert._id, userB._id)).rejects.toMatchObject({ statusCode: 404 });
    });

    it('succeeds for the actual owner', async function() {
        const alert = await alertService.createAlert(userA._id, product._id, 45000);

        const cancelled = await alertService.cancelAlert(alert._id, userA._id);
        expect(cancelled.status).toBe('cancelled');
    });
});

describe('deleteAlert - ownership enforcement', function() {
    it('rejects deletion by a different user with a 404', async function() {
        const alert = await alertService.createAlert(userA._id, product._id, 45000);

        await expect(alertService.deleteAlert(alert._id, userB._id)).rejects.toMatchObject({ statusCode: 404 });

        expect(await Alert.findById(alert._id)).not.toBeNull();
    });

    it('succeeds for the actual owner', async function() {
        const alert = await alertService.createAlert(userA._id, product._id, 45000);

        await alertService.deleteAlert(alert._id, userA._id);

        expect(await Alert.findById(alert._id)).toBeNull();
    });

    it('rejects deleting a nonexistent alert with a 404', async function() {
        await expect(alertService.deleteAlert('000000000000000000000000', userA._id)).rejects.toMatchObject({
            statusCode: 404,
        });
    });
});