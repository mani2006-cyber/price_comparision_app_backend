// tests/integration/routes/category.routes.test.js
//
// Route-level tests for category browsing. No adapter mocking needed -
// unlike /search, these routes never touch a marketplace; they only
// read the already-persisted catalog. Public, no auth.

'use strict';

const request = require('supertest');
const mongoose = require('mongoose');
const config = require('../../../src/config/env');
const Product = require('../../../src/models/Product.model');
const app = require('../../../src/app');

const MARKETPLACE = 'amazon';
const PREFIX = 'CATROUTETEST_';

async function cleanup() {
    await Product.deleteMany({ marketplace: MARKETPLACE, externalId: { $regex: '^' + PREFIX } });
}

function makeProduct(overrides) {
    const id = PREFIX + Math.random().toString(36).slice(2);
    return Object.assign({
            marketplace: MARKETPLACE,
            externalId: id,
            title: 'Category Route Test Product ' + id,
            currentPrice: 1000,
            rawUrl: 'https://www.amazon.in/dp/' + id,
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

describe('GET /api/categories', function() {
    it('lists distinct categories with counts, no auth required', async function() {
        await Product.create([
            makeProduct({ category: 'CatRouteTestAudio' }),
            makeProduct({ category: 'CatRouteTestAudio' }),
        ]);

        const res = await request(app).get('/api/categories');

        expect(res.status).toBe(200);
        const entry = res.body.categories.find(function(c) { return c.category === 'CatRouteTestAudio'; });
        expect(entry).toBeDefined();
        expect(entry.count).toBe(2);
    });
});

describe('GET /api/categories/:category/products', function() {
    it('returns products in that category, unauthenticated', async function() {
        await Product.create(makeProduct({ category: 'CatRouteTestKitchen', currentPrice: 2500 }));

        const res = await request(app).get('/api/categories/CatRouteTestKitchen/products');

        expect(res.status).toBe(200);
        expect(res.body.result.total).toBe(1);
        expect(res.body.result.products[0].currentPrice).toBe(2500);
    });

    it('matches the category case-insensitively', async function() {
        await Product.create(makeProduct({ category: 'CatRouteTestFitness' }));

        const res = await request(app).get('/api/categories/catroutetestFITNESS/products');

        expect(res.status).toBe(200);
        expect(res.body.result.total).toBe(1);
    });

    it('respects sortBy, page, and limit query params', async function() {
        await Product.create([
            makeProduct({ category: 'CatRouteTestPaging', currentPrice: 300 }),
            makeProduct({ category: 'CatRouteTestPaging', currentPrice: 100 }),
            makeProduct({ category: 'CatRouteTestPaging', currentPrice: 200 }),
        ]);

        const res = await request(app).get('/api/categories/CatRouteTestPaging/products?sortBy=price_asc&page=1&limit=2');

        expect(res.status).toBe(200);
        expect(res.body.result.products).toHaveLength(2);
        expect(res.body.result.products.map(function(p) { return p.currentPrice; })).toEqual([100, 200]);
        expect(res.body.result.totalPages).toBe(2);
    });

    it('returns an empty result (not an error) for a category with no products', async function() {
        const res = await request(app).get('/api/categories/CatRouteTestEmpty/products');

        expect(res.status).toBe(200);
        expect(res.body.result.products).toHaveLength(0);
        expect(res.body.result.total).toBe(0);
    });

    it('rejects an invalid sortBy with a 400', async function() {
        const res = await request(app).get('/api/categories/CatRouteTestKitchen/products?sortBy=not_a_real_sort');
        expect(res.status).toBe(400);
    });

    it('rejects a limit above the cap (50) with a 400', async function() {
        const res = await request(app).get('/api/categories/CatRouteTestKitchen/products?limit=999');
        expect(res.status).toBe(400);
    });

    it('rejects a non-numeric page with a 400', async function() {
        const res = await request(app).get('/api/categories/CatRouteTestKitchen/products?page=abc');
        expect(res.status).toBe(400);
    });
});
