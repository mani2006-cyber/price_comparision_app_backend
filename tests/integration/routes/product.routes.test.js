// tests/integration/routes/product.routes.test.js
//
// Route-level tests for search, product detail, and compare-url.
// Mocks adapters (no real network calls) while exercising the full
// real chain: routes -> middleware -> controllers -> services ->
// repositories -> real MongoDB.

'use strict';

jest.mock('../../../src/adapters');
// A real in-memory fake, not a bare auto-mock - product.service.js's
// searchAndPersist() calls cache.getOrSet() internally now (the search
// cache moved from an HTTP middleware down to that service layer - see
// product.service.js's own header comment), so this needs to actually
// behave like a cache for the "authenticated search benefits from
// caching too" test below to mean anything. Cleared in beforeEach so
// nothing leaks between tests - every OTHER test in this file still
// runs against a cold cache, unaffected.
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
const User = require('../../../src/models/User.model');
const Product = require('../../../src/models/Product.model');
const adapters = require('../../../src/adapters');
const cache = require('../../../src/utils/cache');
const app = require('../../../src/app');

const TEST_EMAIL = 'routetest-product@example.com';

function fakeProduct(overrides) {
    return Object.assign({
            marketplace: 'amazon',
            externalId: 'ROUTETEST1',
            title: 'Route Test Laptop',
            currentPrice: 45000,
            rawUrl: 'https://www.amazon.in/dp/ROUTETEST1',
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
    await User.deleteMany({ email: TEST_EMAIL });
    await Product.deleteMany({ externalId: { $regex: /^ROUTETEST/ } });
});

describe('GET /api/search', function() {
    it('works for a guest (no Authorization header)', async function() {
        adapters.searchAllMarketplaces.mockResolvedValue({ results: [fakeProduct()], failures: [] });

        const res = await request(app).get('/api/search').query({ q: 'laptop' });

        expect(res.status).toBe(200);
        expect(res.body.products).toHaveLength(1);
    });

    it('returns 400 when q is missing', async function() {
        const res = await request(app).get('/api/search');
        expect(res.status).toBe(400);
        expect(res.body.error).toContain("'q'");
    });

    it('returns 400 when q is whitespace-only, before ever reaching the adapters', async function() {
        const res = await request(app).get('/api/search').query({ q: '   ' });
        expect(res.status).toBe(400);
        expect(res.body.error).toContain("'q'");
        expect(adapters.searchAllMarketplaces).not.toHaveBeenCalled();
    });

    it('returns 400 with field-level details for an unrecognized sortBy value', async function() {
        const res = await request(app).get('/api/search').query({ q: 'laptop', sortBy: 'bogus' });
        expect(res.status).toBe(400);
        expect(res.body.details).toEqual(
            expect.arrayContaining([expect.objectContaining({ field: 'sortBy' })])
        );
    });

    it('accepts a valid sortBy and passes the trimmed q through to the adapters', async function() {
        adapters.searchAllMarketplaces.mockResolvedValue({ results: [fakeProduct()], failures: [] });

        const res = await request(app).get('/api/search').query({ q: '  laptop  ', sortBy: 'price_asc' });

        expect(res.status).toBe(200);
        expect(adapters.searchAllMarketplaces).toHaveBeenCalledWith('laptop', expect.objectContaining({ sortBy: 'price_asc' }));
    });

    it('records search history when authenticated', async function() {
        adapters.searchAllMarketplaces.mockResolvedValue({ results: [fakeProduct()], failures: [] });

        const signupRes = await request(app)
            .post('/api/auth/signup')
            .send({ name: 'Product Route Test', email: TEST_EMAIL, password: 'plaintext123' });
        const token = signupRes.body.accessToken;

        await request(app).get('/api/search').query({ q: 'laptop' }).set('Authorization', 'Bearer ' + token);

        const historyRes = await request(app)
            .get('/api/search/history')
            .set('Authorization', 'Bearer ' + token);

        expect(historyRes.status).toBe(200);
        expect(historyRes.body.history).toHaveLength(1);
        expect(historyRes.body.history[0].query).toBe('laptop');
    });

    // The actual fix this test proves: an authenticated user's repeat
    // search USED TO force-bypass caching entirely (the old HTTP-level
    // searchCache middleware skipped itself whenever an Authorization
    // header was present, specifically so a cache hit couldn't skip
    // history recording). Now caching lives in product.service.js
    // instead, one layer below the controller, so both things are true
    // at once: the expensive marketplace fetch only happens once, AND
    // every search still gets recorded to history - not a tradeoff
    // between the two anymore.
    it('a repeat authenticated search hits the marketplace fetch only ONCE, but records history BOTH times', async function() {
        adapters.searchAllMarketplaces.mockResolvedValue({ results: [fakeProduct()], failures: [] });

        const signupRes = await request(app)
            .post('/api/auth/signup')
            .send({ name: 'Cache Route Test', email: TEST_EMAIL, password: 'plaintext123' });
        const token = signupRes.body.accessToken;

        await request(app).get('/api/search').query({ q: 'route cache test query' }).set('Authorization', 'Bearer ' + token);
        await request(app).get('/api/search').query({ q: 'route cache test query' }).set('Authorization', 'Bearer ' + token);

        expect(adapters.searchAllMarketplaces).toHaveBeenCalledTimes(1);

        const historyRes = await request(app).get('/api/search/history').set('Authorization', 'Bearer ' + token);
        expect(historyRes.body.history).toHaveLength(1); // same query upserts one row...
        expect(historyRes.body.history[0].searchCount).toBe(2); // ...but both searches were counted
    });

    describe('pagination', function() {
        function manyResults(count) {
            const results = [];
            for (let i = 0; i < count; i++) {
                results.push(fakeProduct({ externalId: 'ROUTETEST' + i, rawUrl: 'https://www.amazon.in/dp/ROUTETEST' + i, currentPrice: i }));
            }
            return results;
        }

        it('returns page 1 with the default limit, plus pagination metadata, when unspecified', async function() {
            adapters.searchAllMarketplaces.mockResolvedValue({ results: manyResults(30), failures: [] });

            const res = await request(app).get('/api/search').query({ q: 'laptop' });

            expect(res.status).toBe(200);
            expect(res.body.page).toBe(1);
            expect(res.body.limit).toBe(config.search.defaultLimit);
            expect(res.body.products).toHaveLength(config.search.defaultLimit);
            expect(res.body.resultCount).toBe(30); // total, not just this page
            expect(res.body.totalPages).toBe(Math.ceil(30 / config.search.defaultLimit));
        });

        it('respects explicit page/limit query params', async function() {
            adapters.searchAllMarketplaces.mockResolvedValue({ results: manyResults(25), failures: [] });

            const res = await request(app).get('/api/search').query({ q: 'laptop', page: 2, limit: 10 });

            expect(res.status).toBe(200);
            expect(res.body.products).toHaveLength(10);
            expect(res.body.page).toBe(2);
            expect(res.body.totalPages).toBe(3);
        });

        it('rejects a limit above the configured cap with a 400', async function() {
            const res = await request(app).get('/api/search').query({ q: 'laptop', limit: 999 });
            expect(res.status).toBe(400);
        });

        it('rejects page=0 with a 400', async function() {
            const res = await request(app).get('/api/search').query({ q: 'laptop', page: 0 });
            expect(res.status).toBe(400);
        });
    });
});

describe('GET /api/search/history', function() {
    it('rejects a request with no access token', async function() {
        const res = await request(app).get('/api/search/history');
        expect(res.status).toBe(401);
    });
});

describe('GET /api/products/:id', function() {
    it('returns a persisted product by id', async function() {
        const product = await Product.create(fakeProduct());

        const res = await request(app).get('/api/products/' + product._id);
        expect(res.status).toBe(200);
        expect(res.body.product.title).toBe('Route Test Laptop');
    });

    it('returns 404 for a nonexistent id', async function() {
        const res = await request(app).get('/api/products/000000000000000000000000');
        expect(res.status).toBe(404);
    });
});

describe('POST /api/compare-url', function() {
    it('returns a comparison result for a supported URL', async function() {
        adapters.detectMarketplaceFromUrl.mockReturnValue('amazon');
        adapters.searchByLink.mockResolvedValue(fakeProduct());
        adapters.searchAllMarketplaces.mockResolvedValue({ results: [fakeProduct()], failures: [] });

        const res = await request(app)
            .post('/api/compare-url')
            .send({ url: 'https://www.amazon.in/dp/ROUTETEST1' });

        expect(res.status).toBe(200);
        expect(res.body.result.detectedMarketplace).toBe('amazon');
    });

    it('returns 400 for an unsupported marketplace URL', async function() {
        adapters.detectMarketplaceFromUrl.mockReturnValue(null);
        adapters.getActiveMarketplaces.mockReturnValue(['amazon', 'flipkart']);

        const res = await request(app).post('/api/compare-url').send({ url: 'https://www.ebay.com/itm/123' });

        expect(res.status).toBe(400);
    });

    it('returns 400 for a malformed url, before ever calling detectMarketplaceFromUrl', async function() {
        const res = await request(app).post('/api/compare-url').send({ url: 'not-a-url' });

        expect(res.status).toBe(400);
        expect(adapters.detectMarketplaceFromUrl).not.toHaveBeenCalled();
    });

    it('returns 400 when url is missing from the body entirely', async function() {
        const res = await request(app).post('/api/compare-url').send({});

        expect(res.status).toBe(400);
        expect(res.body.error).toContain("'url'");
    });

    it('works for a supported Vijay Sales URL - the real marketplace added in this session', async function() {
        adapters.detectMarketplaceFromUrl.mockReturnValue('vijaysales');
        adapters.searchByLink.mockResolvedValue(fakeProduct({ marketplace: 'vijaysales', externalId: 'ROUTETEST1' }));
        adapters.searchAllMarketplaces.mockResolvedValue({ results: [], failures: [] });

        const res = await request(app)
            .post('/api/compare-url')
            .send({ url: 'https://www.vijaysales.com/p/P1/1/apple-iphone-16-black' });

        expect(res.status).toBe(200);
        expect(res.body.result.detectedMarketplace).toBe('vijaysales');
    });
});