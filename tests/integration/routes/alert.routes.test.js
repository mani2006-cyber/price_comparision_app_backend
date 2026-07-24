// tests/integration/routes/alert.routes.test.js
//
// Route-level tests for the alert endpoints. Every route requires auth.
// Covers both layers of targetPrice validation - controller (well-
// formed positive number) and service (must be below current price) -
// plus ownership enforcement on cancel.

'use strict';

const request = require('supertest');
const mongoose = require('mongoose');
const config = require('../../../src/config/env');
const User = require('../../../src/models/User.model');
const Product = require('../../../src/models/Product.model');
const app = require('../../../src/app');

const EMAIL_A = 'routetest-alert-a@example.com';
const EMAIL_B = 'routetest-alert-b@example.com';
const EXTERNAL_ID = 'ALERTROUTETEST_1';

let product;
let tokenA;
let tokenB;

beforeAll(async function() {
    await mongoose.connect(config.mongoUri);
});

afterAll(async function() {
    await mongoose.disconnect();
});

beforeEach(async function() {
    await User.deleteMany({ email: { $in: [EMAIL_A, EMAIL_B] } });
    await Product.deleteMany({ marketplace: 'amazon', externalId: EXTERNAL_ID });

    product = await Product.create({
        marketplace: 'amazon',
        externalId: EXTERNAL_ID,
        title: 'Alert Route Test Product',
        currentPrice: 50000,
        rawUrl: 'https://www.amazon.in/dp/' + EXTERNAL_ID,
        fetchedVia: 'scraper',
    });

    const signupA = await request(app).post('/api/auth/signup').send({ name: 'A', email: EMAIL_A, password: 'plaintext123' });
    const signupB = await request(app).post('/api/auth/signup').send({ name: 'B', email: EMAIL_B, password: 'plaintext123' });
    tokenA = signupA.body.accessToken;
    tokenB = signupB.body.accessToken;
});

describe('GET /api/alerts', function() {
    it('rejects a request with no access token', async function() {
        const res = await request(app).get('/api/alerts');
        expect(res.status).toBe(401);
    });
});

describe('POST /api/alerts', function() {
    it('creates an alert with a valid target price below the current price', async function() {
        const res = await request(app)
            .post('/api/alerts')
            .set('Authorization', 'Bearer ' + tokenA)
            .send({ productId: product._id.toString(), targetPrice: 45000 });

        expect(res.status).toBe(201);
        expect(res.body.alert.targetPrice).toBe(45000);
        expect(res.body.alert.status).toBe('active');
    });

    it('rejects a target price at or above the current price with a 400', async function() {
        const res = await request(app)
            .post('/api/alerts')
            .set('Authorization', 'Bearer ' + tokenA)
            .send({ productId: product._id.toString(), targetPrice: 60000 });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('lower than the current price');
    });

    it('rejects a malformed (non-numeric) target price with a 400, before ever reaching the service', async function() {
        const res = await request(app)
            .post('/api/alerts')
            .set('Authorization', 'Bearer ' + tokenA)
            .send({ productId: product._id.toString(), targetPrice: 'not-a-number' });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('targetPrice');
    });

    it('rejects a missing productId with a 400', async function() {
        const res = await request(app)
            .post('/api/alerts')
            .set('Authorization', 'Bearer ' + tokenA)
            .send({ targetPrice: 45000 });

        expect(res.status).toBe(400);
    });

    it('rejects a nonexistent productId with a 404', async function() {
        const res = await request(app)
            .post('/api/alerts')
            .set('Authorization', 'Bearer ' + tokenA)
            .send({ productId: '000000000000000000000000', targetPrice: 1000 });

        expect(res.status).toBe(404);
    });
});

describe('full flow: create -> list -> cancel, with ownership checks', function() {
    it('walks the entire alert lifecycle and enforces ownership on cancel', async function() {
        const createRes = await request(app)
            .post('/api/alerts')
            .set('Authorization', 'Bearer ' + tokenA)
            .send({ productId: product._id.toString(), targetPrice: 45000 });
        const alertId = createRes.body.alert._id;

        const listRes = await request(app).get('/api/alerts').set('Authorization', 'Bearer ' + tokenA);
        expect(listRes.body.count).toBe(1);

        // userB cannot cancel userA's alert
        const wrongCancel = await request(app)
            .post('/api/alerts/' + alertId + '/cancel')
            .set('Authorization', 'Bearer ' + tokenB);
        expect(wrongCancel.status).toBe(404);

        // userA (owner) can cancel it
        const correctCancel = await request(app)
            .post('/api/alerts/' + alertId + '/cancel')
            .set('Authorization', 'Bearer ' + tokenA);
        expect(correctCancel.status).toBe(200);
        expect(correctCancel.body.alert.status).toBe('cancelled');

        // Cancelling the same alert again should 404 (already cancelled)
        const secondCancel = await request(app)
            .post('/api/alerts/' + alertId + '/cancel')
            .set('Authorization', 'Bearer ' + tokenA);
        expect(secondCancel.status).toBe(404);
    });
});