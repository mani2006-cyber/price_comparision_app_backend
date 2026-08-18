// tests/integration/routes/admin.routes.test.js
//
// Route-level tests for the admin catalog CRUD. Every route sits behind
// adminAuth.middleware.js's requireAdmin (x-admin-key header, checked
// against config.admin.apiKey) - the auth-gating tests below run WITHOUT
// that header/with a wrong one to prove it actually blocks; every other
// test sends the correct key (.env.test's ADMIN_API_KEY).

'use strict';

const request = require('supertest');
const mongoose = require('mongoose');
const config = require('../../../src/config/env');
const AdminProduct = require('../../../src/models/AdminProduct.model');
const app = require('../../../src/app');

const PREFIX = 'ADMINROUTETEST_';
const ADMIN_KEY = config.admin.apiKey;

async function cleanup() {
    await AdminProduct.deleteMany({ title: { $regex: '^' + PREFIX } });
}

function makeBody(overrides) {
    const id = Math.random().toString(36).slice(2);
    return Object.assign({
            title: PREFIX + 'Product ' + id,
            category: 'AdminRouteTestDefault',
            price: 1000,
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

describe('admin auth gating', function() {
    it('rejects a request with no x-admin-key header at all, with a 401', async function() {
        const res = await request(app).get('/api/admin/products');
        expect(res.status).toBe(401);
    });

    it('rejects a request with the wrong key, with a 401', async function() {
        const res = await request(app).get('/api/admin/products').set('x-admin-key', 'definitely-not-the-real-key');
        expect(res.status).toBe(401);
    });

    it('allows a request with the correct key', async function() {
        const res = await request(app).get('/api/admin/products').set('x-admin-key', ADMIN_KEY);
        expect(res.status).toBe(200);
    });
});

describe('POST /api/admin/products', function() {
    it('creates a catalog product', async function() {
        const res = await request(app)
            .post('/api/admin/products')
            .set('x-admin-key', ADMIN_KEY)
            .send(makeBody({ title: PREFIX + 'Sony Headphones', price: 24990 }));

        expect(res.status).toBe(201);
        expect(res.body.product.title).toBe(PREFIX + 'Sony Headphones');
        expect(res.body.product.price).toBe(24990);
    });

    it('rejects a missing title with a 400', async function() {
        const body = makeBody();
        delete body.title;

        const res = await request(app).post('/api/admin/products').set('x-admin-key', ADMIN_KEY).send(body);
        expect(res.status).toBe(400);
    });

    it('rejects a negative price with a 400', async function() {
        const res = await request(app)
            .post('/api/admin/products')
            .set('x-admin-key', ADMIN_KEY)
            .send(makeBody({ price: -500 }));

        expect(res.status).toBe(400);
    });
});

describe('GET /api/admin/products/:id, PATCH, DELETE', function() {
    it('runs a full create -> get -> update -> delete -> 404 cycle', async function() {
        const created = await request(app)
            .post('/api/admin/products')
            .set('x-admin-key', ADMIN_KEY)
            .send(makeBody({ price: 1000 }));
        const id = created.body.product._id;

        const fetched = await request(app).get('/api/admin/products/' + id).set('x-admin-key', ADMIN_KEY);
        expect(fetched.status).toBe(200);
        expect(fetched.body.product.price).toBe(1000);

        const updated = await request(app)
            .patch('/api/admin/products/' + id)
            .set('x-admin-key', ADMIN_KEY)
            .send({ price: 1500 });
        expect(updated.status).toBe(200);
        expect(updated.body.product.price).toBe(1500);

        const deleted = await request(app).delete('/api/admin/products/' + id).set('x-admin-key', ADMIN_KEY);
        expect(deleted.status).toBe(200);

        const afterDelete = await request(app).get('/api/admin/products/' + id).set('x-admin-key', ADMIN_KEY);
        expect(afterDelete.status).toBe(404);
    });

    it('rejects a PATCH with an empty body with a 400', async function() {
        const created = await request(app)
            .post('/api/admin/products')
            .set('x-admin-key', ADMIN_KEY)
            .send(makeBody());
        const id = created.body.product._id;

        const res = await request(app).patch('/api/admin/products/' + id).set('x-admin-key', ADMIN_KEY).send({});
        expect(res.status).toBe(400);
    });
});

describe('GET /api/admin/products - filtering', function() {
    it('filters by category and includes hidden entries', async function() {
        await request(app).post('/api/admin/products').set('x-admin-key', ADMIN_KEY)
            .send(makeBody({ category: 'AdminRouteTestFilterA' }));
        await request(app).post('/api/admin/products').set('x-admin-key', ADMIN_KEY)
            .send(makeBody({ category: 'AdminRouteTestFilterB', status: 'hidden' }));

        const res = await request(app)
            .get('/api/admin/products')
            .set('x-admin-key', ADMIN_KEY)
            .query({ category: 'AdminRouteTestFilterA' });

        expect(res.status).toBe(200);
        expect(res.body.result.total).toBe(1);
    });
});
