// tests/integration/routes/wishlist.routes.test.js
//
// Route-level tests for the wishlist endpoints. Every route requires
// auth - the ownership checks here (a different user cannot touch
// someone else's item) are the security boundary this file locks in.

'use strict';

const request = require('supertest');
const mongoose = require('mongoose');
const config = require('../../../src/config/env');
const User = require('../../../src/models/User.model');
const Product = require('../../../src/models/Product.model');
const app = require('../../../src/app');

const EMAIL_A = 'routetest-wishlist-a@example.com';
const EMAIL_B = 'routetest-wishlist-b@example.com';
const EXTERNAL_ID = 'WISHROUTETEST_1';

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
        title: 'Wishlist Route Test Product',
        currentPrice: 19999,
        rawUrl: 'https://www.amazon.in/dp/' + EXTERNAL_ID,
        fetchedVia: 'scraper',
    });

    const signupA = await request(app).post('/api/auth/signup').send({ name: 'A', email: EMAIL_A, password: 'plaintext123' });
    const signupB = await request(app).post('/api/auth/signup').send({ name: 'B', email: EMAIL_B, password: 'plaintext123' });
    tokenA = signupA.body.accessToken;
    tokenB = signupB.body.accessToken;
});

describe('GET /api/wishlist', function() {
    it('rejects a request with no access token', async function() {
        const res = await request(app).get('/api/wishlist');
        expect(res.status).toBe(401);
    });
});

describe('POST /api/wishlist', function() {
    it('adds a product to the wishlist', async function() {
        const res = await request(app)
            .post('/api/wishlist')
            .set('Authorization', 'Bearer ' + tokenA)
            .send({ productId: product._id.toString(), notes: 'testing' });

        expect(res.status).toBe(201);
        expect(res.body.item.notes).toBe('testing');
    });

    it('rejects a duplicate add with a 409', async function() {
        await request(app).post('/api/wishlist').set('Authorization', 'Bearer ' + tokenA).send({ productId: product._id.toString() });

        const res = await request(app)
            .post('/api/wishlist')
            .set('Authorization', 'Bearer ' + tokenA)
            .send({ productId: product._id.toString() });

        expect(res.status).toBe(409);
    });

    it('rejects a nonexistent productId with a 404', async function() {
        const res = await request(app)
            .post('/api/wishlist')
            .set('Authorization', 'Bearer ' + tokenA)
            .send({ productId: '000000000000000000000000' });

        expect(res.status).toBe(404);
    });
});

describe('full flow: add -> list -> history -> remove, with ownership checks', function() {
    it('walks the entire wishlist lifecycle and enforces ownership at every step', async function() {
        const addRes = await request(app)
            .post('/api/wishlist')
            .set('Authorization', 'Bearer ' + tokenA)
            .send({ productId: product._id.toString() });
        const itemId = addRes.body.item._id;

        // List - userA sees it
        const listRes = await request(app).get('/api/wishlist').set('Authorization', 'Bearer ' + tokenA);
        expect(listRes.body.count).toBe(1);

        // Price history - accessible to owner
        const historyRes = await request(app)
            .get('/api/wishlist/' + itemId + '/history')
            .set('Authorization', 'Bearer ' + tokenA);
        expect(historyRes.status).toBe(200);

        // userB cannot delete userA's item
        const wrongDelete = await request(app)
            .delete('/api/wishlist/' + itemId)
            .set('Authorization', 'Bearer ' + tokenB);
        expect(wrongDelete.status).toBe(404);

        // Item still there after the blocked delete
        const stillThere = await request(app).get('/api/wishlist').set('Authorization', 'Bearer ' + tokenA);
        expect(stillThere.body.count).toBe(1);

        // userA (owner) CAN delete it
        const correctDelete = await request(app)
            .delete('/api/wishlist/' + itemId)
            .set('Authorization', 'Bearer ' + tokenA);
        expect(correctDelete.status).toBe(200);

        const afterDelete = await request(app).get('/api/wishlist').set('Authorization', 'Bearer ' + tokenA);
        expect(afterDelete.body.count).toBe(0);
    });
});