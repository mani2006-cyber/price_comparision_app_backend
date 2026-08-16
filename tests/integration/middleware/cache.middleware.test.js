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
const productRepository = require('../../../src/repositories/product.repository');
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
    // The whole cache module is auto-mocked in this file, which replaces
    // getOrSet with a stub returning undefined by default - but
    // product.service.js's searchAndPersist (exercised via GET /api/search
    // below) destructures its return value, so a bare auto-mock would
    // throw. This pass-through implementation (always "fresh", real
    // fetchFn always called) keeps that code path working exactly like
    // Redis being disabled would, without needing to hand-simulate real
    // cache hit/miss semantics here - that's covered properly in
    // product.service.test.js instead.
    cache.getOrSet.mockImplementation(async function(key, ttl, fetchFn) {
        return { value: await fetchFn(), fromCache: false };
    });
});
// GET /api/search does NOT use this HTTP-level cache.middleware.js
// anymore - it used to (guest-only, via the same cacheResponse() this
// file tests below for /products/:id), but that meant a cache HIT
// short-circuited before the controller ever ran, which is also where
// search history gets recorded - so an authenticated search had to skip
// caching ENTIRELY, guest or not, just to guarantee history kept
// working. The cache moved one layer down instead: product.service.js's
// searchAndPersist() now caches the expensive marketplace-fetch step
// itself, while the controller (and therefore history recording) always
// runs regardless. See tests/integration/services/product.service.test.js
// for coverage of that cache-aside, and product.routes.test.js's
// "records search history when authenticated" test (now proven to
// benefit from caching too, not just guests) for the end-to-end route
// behavior.
describe('GET /api/search - no HTTP-level caching', function() {
    it('never sets an X-Cache header - this route has no cache.middleware.js in its chain at all anymore', async function() {
        adapters.searchAllMarketplaces.mockResolvedValue({ results: [fakeProduct()], failures: [] });

        const res = await request(app).get('/api/search').query({ q: 'laptop' });

        expect(res.status).toBe(200);
        expect(res.headers['x-cache']).toBeUndefined();
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

// Confirmed live: two near-simultaneous requests for the exact same
// compare-url both missed the cache (neither had finished writing yet)
// and both ran the full expensive pipeline independently. This
// reproduces the same race deliberately - findById is made artificially
// slow so the second concurrent request definitely arrives while the
// first is still in flight, then proves it got coalesced instead of
// triggering its own second DB query.
describe('GET /api/products/:id - concurrent request coalescing', function() {
    it('runs the underlying lookup only ONCE for two concurrent requests, and both get the same response', async function() {
        cache.get.mockResolvedValue(null); // force a miss on both

        const Product = require('../../../src/models/Product.model');
        await Product.deleteOne({ marketplace: 'amazon', externalId: 'CACHEMWTEST1' });
        const product = await Product.create(fakeProduct());

        const findByIdSpy = jest.spyOn(productRepository, 'findById');
        findByIdSpy.mockImplementationOnce(function(id) {
            // Real lookup, just artificially delayed - not a fake value -
            // so the second concurrent request below is guaranteed to
            // arrive while this one is still in flight.
            return new Promise(function(resolve) {
                setTimeout(function() {
                    mongoose.model('Product').findById(id).then(resolve);
                }, 150);
            });
        });

        const req1 = request(app).get('/api/products/' + product._id);
        // Fired shortly after, while the first is still artificially
        // delayed inside findById above - reproduces the live timing
        // (49ms apart) that caused the original bug.
        await new Promise(function(resolve) { setTimeout(resolve, 20); });
        const req2 = request(app).get('/api/products/' + product._id);

        const [res1, res2] = await Promise.all([req1, req2]);

        expect(res1.status).toBe(200);
        expect(res2.status).toBe(200);
        expect(res1.body.product._id).toBe(product._id.toString());
        expect(res2.body.product._id).toBe(product._id.toString());
        expect(findByIdSpy).toHaveBeenCalledTimes(1); // NOT 2 - the second request was coalesced

        findByIdSpy.mockRestore();
        await Product.deleteOne({ _id: product._id });
    });
});