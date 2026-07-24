// tests/integration/middleware/cache.middleware.test.js
//
// Route-level test proving cache.middleware.js actually produces HIT/
// MISS behavior end-to-end. Mocks src/utils/cache.js directly (same
// pattern as mocking adapters elsewhere) - a real Redis instance is
// never required for this test to be meaningful or deterministic.

'use strict';

jest.mock('../../../src/adapters');
jest.mock('../../../src/utils/cache');

const request = require('supertest');
const mongoose = require('mongoose');
const config = require('../../../src/config/env');
const adapters = require('../../../src/adapters');
const cache = require('../../../src/utils/cache');
const app = require('../../../src/app');

function fakeProduct() {
    return {
        marketplace: 'amazon',
        externalId: 'CACHEMWTEST1',
        title: 'Cache Middleware Test Laptop',
        currentPrice: 45000,
        rawUrl: 'https://www.amazon.in/dp/CACHEMWTEST1',
        fetchedVia: 'api',
        images: [],
        keywords: [],
        attributes: {},
        metadata: {},
    };
}

beforeAll(async function() {
    await mongoose.connect(config.mongoUri);
});

afterAll(async function() {
    await mongoose.disconnect();
});

beforeEach(function() {
    jest.clearAllMocks();
    cache.set.mockResolvedValue(true);
    cache.del.mockResolvedValue(true);
});
describe('GET /api/search caching', function() {
    it('sets X-Cache: MISS and stores the response when the cache is empty (guest request)', async function() {
        cache.get.mockResolvedValue(null); // simulate a cache miss
        adapters.searchAllMarketplaces.mockResolvedValue({ results: [fakeProduct()], failures: [] });

        const res = await request(app).get('/api/search').query({ q: 'laptop' });

        expect(res.status).toBe(200);
        expect(res.headers['x-cache']).toBe('MISS');
        expect(cache.set).toHaveBeenCalledTimes(1); // the middleware wrote the response to cache
    });

    it('returns the cached body directly with X-Cache: HIT, WITHOUT calling adapters at all', async function() {
        const cachedBody = { success: true, query: 'laptop', resultCount: 1, products: [fakeProduct()], marketplaceFailures: [] };
        cache.get.mockResolvedValue(cachedBody); // simulate a cache hit

        const res = await request(app).get('/api/search').query({ q: 'laptop' });

        expect(res.status).toBe(200);
        expect(res.headers['x-cache']).toBe('HIT');
        expect(res.body).toEqual(cachedBody);
        // The whole point of a cache HIT: the expensive marketplace search
        // never runs at all.
        expect(adapters.searchAllMarketplaces).not.toHaveBeenCalled();
    });

    it('SKIPS the cache entirely for an authenticated request (side-effect safety)', async function() {
        cache.get.mockResolvedValue({ success: true, products: ['should never be returned'] });
        adapters.searchAllMarketplaces.mockResolvedValue({ results: [fakeProduct()], failures: [] });

        const res = await request(app)
            .get('/api/search')
            .query({ q: 'laptop' })
            .set('Authorization', 'Bearer fake-token-value'); // presence alone is enough to trigger skip()

        // An authenticated request must never short-circuit on a cached
        // body - it has a side effect (history recording) a cache hit would
        // silently bypass. cache.get should not even be consulted.
        expect(cache.get).not.toHaveBeenCalled();
    });
});

describe('GET /api/products/:id caching', function() {
    it('uses the product id as the cache key and reports a MISS on first request', async function() {
        cache.get.mockResolvedValue(null);

        const Product = require('../../../src/models/Product.model');
        await Product.deleteOne({ marketplace: 'amazon', externalId: 'CACHEMWTEST1' });
        const product = await Product.create(fakeProduct());

        const res = await request(app).get('/api/products/' + product._id);

        expect(res.status).toBe(200);
        expect(res.headers['x-cache']).toBe('MISS');
        expect(cache.get).toHaveBeenCalledWith(expect.stringContaining(product._id.toString()));

        await Product.deleteOne({ _id: product._id });
    });
});