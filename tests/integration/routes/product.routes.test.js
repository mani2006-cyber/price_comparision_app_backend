// tests/integration/routes/product.routes.test.js
//
// Route-level tests for search, product detail, and compare-url.
// Mocks adapters (no real network calls) while exercising the full
// real chain: routes -> middleware -> controllers -> services ->
// repositories -> real MongoDB.

'use strict';

jest.mock('../../../src/adapters');

const request = require('supertest');
const mongoose = require('mongoose');
const config = require('../../../src/config/env');
const User = require('../../../src/models/User.model');
const Product = require('../../../src/models/Product.model');
const adapters = require('../../../src/adapters');
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