// tests/integration/routes/category.routes.test.js
//
// Route-level tests for category browsing. GET / and GET /:category/products
// never touch a marketplace - they only read the admin-curated catalog
// (AdminProduct). GET /:category/products/:id is the "click through"
// route - it DOES trigger a real search pipeline under the hood (see
// category.service.js's getProductListings), so it needs the same
// adapters/cache mocking product.routes.test.js's /search tests use.
// All three routes are public, no auth.

'use strict';

jest.mock('../../../src/adapters');
jest.mock('../../../src/utils/cache', function() {
    const store = new Map();
    return {
        get: jest.fn(async function(key) { return store.has(key) ? store.get(key) : null; }),
        set: jest.fn(async function(key, value) { store.set(key, value); return true; }),
        del: jest.fn(async function(key) { return store.delete(key); }),
        getOrSet: jest.fn(async function(key, ttlSeconds, fetchFn) {
            if (store.has(key)) {
                return { value: store.get(key), fromCache: true };
            }
            const fresh = await fetchFn();
            store.set(key, fresh);
            return { value: fresh, fromCache: false };
        }),
        __store: store,
    };
});

const request = require('supertest');
const mongoose = require('mongoose');
const config = require('../../../src/config/env');
const AdminProduct = require('../../../src/models/AdminProduct.model');
const Product = require('../../../src/models/Product.model');
const adapters = require('../../../src/adapters');
const cache = require('../../../src/utils/cache');
const app = require('../../../src/app');

const PREFIX = 'CATROUTETEST_';

async function cleanup() {
    await AdminProduct.deleteMany({ title: { $regex: '^' + PREFIX } });
    await Product.deleteMany({ externalId: { $regex: '^' + PREFIX } });
}

function makeAdminProduct(overrides) {
    const id = Math.random().toString(36).slice(2);
    return Object.assign({
            title: PREFIX + 'Product ' + id,
            category: 'CatRouteTestDefault',
            price: 1000,
        },
        overrides
    );
}

function fakeSearchResult(overrides) {
    return Object.assign({
            marketplace: 'amazon',
            externalId: PREFIX + 'EXT1',
            title: 'Live Listing For ' + PREFIX,
            currentPrice: 2500,
            rawUrl: 'https://www.amazon.in/dp/' + PREFIX + 'EXT1',
            fetchedVia: 'api',
            images: [],
            keywords: [],
            attributes: {},
            metadata: {},
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

beforeEach(async function() {
    jest.clearAllMocks();
    cache.__store.clear();
    await cleanup();
});
afterEach(cleanup);

describe('GET /api/categories', function() {
    it('lists distinct categories with counts, no auth required', async function() {
        await AdminProduct.create([
            makeAdminProduct({ category: 'CatRouteTestAudio' }),
            makeAdminProduct({ category: 'CatRouteTestAudio' }),
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
        await AdminProduct.create(makeAdminProduct({ category: 'CatRouteTestKitchen', price: 2500 }));

        const res = await request(app).get('/api/categories/CatRouteTestKitchen/products');

        expect(res.status).toBe(200);
        expect(res.body.result.total).toBe(1);
        expect(res.body.result.products[0].price).toBe(2500);
    });

    it('matches the category case-insensitively', async function() {
        await AdminProduct.create(makeAdminProduct({ category: 'CatRouteTestFitness' }));

        const res = await request(app).get('/api/categories/catroutetestFITNESS/products');

        expect(res.status).toBe(200);
        expect(res.body.result.total).toBe(1);
    });

    it('respects sortBy, page, and limit query params', async function() {
        await AdminProduct.create([
            makeAdminProduct({ category: 'CatRouteTestPaging', price: 300 }),
            makeAdminProduct({ category: 'CatRouteTestPaging', price: 100 }),
            makeAdminProduct({ category: 'CatRouteTestPaging', price: 200 }),
        ]);

        const res = await request(app).get('/api/categories/CatRouteTestPaging/products?sortBy=price_asc&page=1&limit=2');

        expect(res.status).toBe(200);
        expect(res.body.result.products).toHaveLength(2);
        expect(res.body.result.products.map(function(p) { return p.price; })).toEqual([100, 200]);
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

describe('GET /api/categories/:category/products/:id', function() {
    it('triggers a live search keyed by the admin product title and returns its listings', async function() {
        const product = await AdminProduct.create(makeAdminProduct({ category: 'CatRouteTestClick' }));
        adapters.searchAllMarketplaces.mockResolvedValue({ results: [fakeSearchResult()], failures: [] });

        const res = await request(app).get('/api/categories/CatRouteTestClick/products/' + product._id.toString());

        expect(res.status).toBe(200);
        expect(res.body.result.adminProduct._id).toBe(product._id.toString());
        expect(res.body.result.listings.products).toHaveLength(1);
        expect(adapters.searchAllMarketplaces).toHaveBeenCalledWith(product.title, expect.anything());
    });

    it('returns 404 for an id that does not exist', async function() {
        const fakeId = new mongoose.Types.ObjectId().toString();
        const res = await request(app).get('/api/categories/CatRouteTestClick/products/' + fakeId);
        expect(res.status).toBe(404);
    });

    it('returns 404 for a hidden product, not clickable even with a known id', async function() {
        const hidden = await AdminProduct.create(makeAdminProduct({ status: 'hidden' }));
        const res = await request(app).get('/api/categories/CatRouteTestDefault/products/' + hidden._id.toString());
        expect(res.status).toBe(404);
    });
});
