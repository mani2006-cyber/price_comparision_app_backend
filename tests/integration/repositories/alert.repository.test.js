// tests/integration/repositories/alert.repository.test.js
//
// Integration test for alert.repository.js. findActiveByProduct's
// idempotency (via markTriggered) is the guarantee that prevents a
// user from ever being notified twice for the same price drop (File 20).

'use strict';

const mongoose = require('mongoose');
const config = require('../../../src/config/env');
const User = require('../../../src/models/User.model');
const Product = require('../../../src/models/Product.model');
const Alert = require('../../../src/models/Alert.model');
const alertRepository = require('../../../src/repositories/alert.repository');

const EMAIL_A = 'repotest-alert-a@example.com';
const EMAIL_B = 'repotest-alert-b@example.com';
const MARKETPLACE = 'amazon';
const EXTERNAL_ID = 'ALERTREPOTEST_1';

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
        title: 'Alert Repo Test Product',
        currentPrice: 50000,
        rawUrl: 'https://www.amazon.in/dp/' + EXTERNAL_ID,
        fetchedVia: 'scraper',
    });

    await Alert.deleteMany({ userId: { $in: [userA._id, userB._id] } });
});

describe('findActiveByProduct', function() {
    it('finds alerts whose targetPrice has been met, comparing in the query itself', async function() {
        // "Met" means targetPrice >= currentPrice - the price has fallen TO
        // OR BELOW what the user was waiting for. At currentPrice=44000:
        // 48000 and 45000 both qualify (>= 44000), 40000 does not.
        const alertHigh = await alertRepository.create(userA._id, product._id, 48000);
        const alertMid = await alertRepository.create(userA._id, product._id, 45000);
        await alertRepository.create(userA._id, product._id, 40000); // NOT met at 44000

        const met = await alertRepository.findActiveByProduct(product._id, 44000);
        const metIds = met.map(function(a) { return a._id.toString(); });

        expect(met).toHaveLength(2);
        expect(metIds).toEqual(expect.arrayContaining([alertHigh._id.toString(), alertMid._id.toString()]));
    });

    it('excludes an alert whose target has NOT yet been reached', async function() {
        await alertRepository.create(userA._id, product._id, 45000);

        // At currentPrice=46000, a target of 45000 has NOT been reached yet
        // (45000 is not >= 46000) - this is the case the buggy version of
        // this test got wrong.
        const met = await alertRepository.findActiveByProduct(product._id, 46000);
        expect(met).toHaveLength(0);
    });
});

describe('markTriggered', function() {
    it('transitions an alert from active to triggered with the trigger price recorded', async function() {
        const alert = await alertRepository.create(userA._id, product._id, 48000);

        const triggered = await alertRepository.markTriggered(alert._id, 46000);

        expect(triggered.status).toBe('triggered');
        expect(triggered.triggeredAtPrice).toBe(46000);
    });

    it('is idempotent - calling it again on an already-triggered alert no-ops (returns null)', async function() {
        const alert = await alertRepository.create(userA._id, product._id, 48000);
        await alertRepository.markTriggered(alert._id, 46000);

        const secondAttempt = await alertRepository.markTriggered(alert._id, 45000);
        expect(secondAttempt).toBeNull();

        const reloaded = await Alert.findById(alert._id);
        expect(reloaded.triggeredAtPrice).toBe(46000);
    });
});

describe('countActiveByUser', function() {
    it('counts only active alerts, excluding triggered/cancelled ones', async function() {
        const alert1 = await alertRepository.create(userA._id, product._id, 48000);
        await alertRepository.create(userA._id, product._id, 40000);
        await alertRepository.markTriggered(alert1._id, 46000);

        const count = await alertRepository.countActiveByUser(userA._id);
        expect(count).toBe(1);
    });
});

describe('cancelByIdForUser - ownership scoping', function() {
    it('does NOT cancel an alert belonging to a different user', async function() {
        const alert = await alertRepository.create(userA._id, product._id, 45000);

        const result = await alertRepository.cancelByIdForUser(alert._id, userB._id);
        expect(result).toBeNull();

        const reloaded = await Alert.findById(alert._id);
        expect(reloaded.status).toBe('active');
    });

    it('DOES cancel when called by the actual owner', async function() {
        const alert = await alertRepository.create(userA._id, product._id, 45000);

        const result = await alertRepository.cancelByIdForUser(alert._id, userA._id);
        expect(result.status).toBe('cancelled');
    });
});