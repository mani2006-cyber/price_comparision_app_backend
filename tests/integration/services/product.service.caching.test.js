// tests/integration/services/product.service.caching.test.js
//
// Tests product.service.js's searchAndPersist() cache-aside specifically
// - kept in a SEPARATE file from product.service.test.js rather than a
// new describe block there, because mocking src/utils/cache applies for
// the whole file: product.service.test.js's existing tests all search
// for the same literal string ('test query') across several `it()`
// blocks, each expecting ITS OWN mocked adapter data back fresh - a
// real (even in-memory) cache shared across those would make the
// second/third test silently receive the FIRST test's cached result
// instead of exercising its own mock. This file's mocked cache is
// reset between every test specifically to avoid that trap for its own
// tests.
//
// adapters is mocked (no real network calls); src/utils/cache is
// replaced with a small in-memory fake that behaves like the real
// get/set/getOrSet contract (src/utils/cache.js) - real enough to prove
// actual cache hit/miss behavior, not just "Redis disabled -> always a
// no-op miss" (the case every OTHER test file's real cache.js already
// exercises under REDIS_ENABLED=false).

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
        __store: store, // test-only escape hatch - cleared in beforeEach
    };
});

const mongoose = require('mongoose');
const config = require('../../../src/config/env');
const Product = require('../../../src/models/Product.model');
const adapters = require('../../../src/adapters');
const cache = require('../../../src/utils/cache');
const productService = require('../../../src/services/product.service');

function fakeProviderProduct(overrides) {
    return Object.assign({
            marketplace: 'amazon',
            externalId: 'SVCCACHETEST1',
            title: 'Cache Test Product',
            currentPrice: 4999,
            rawUrl: 'https://www.amazon.in/dp/SVCCACHETEST1',
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
    await Product.deleteMany({ externalId: { $regex: /^SVCCACHETEST/ } });
});

describe('searchAndPersist caching', function() {
    it('calls adapters.searchAllMarketplaces only ONCE for two consecutive identical-query calls - the second is a cache hit', async function() {
        adapters.searchAllMarketplaces.mockResolvedValue({ results: [fakeProviderProduct()], failures: [] });

        await productService.searchAndPersist('iphone 16');
        await productService.searchAndPersist('iphone 16');

        expect(adapters.searchAllMarketplaces).toHaveBeenCalledTimes(1);
    });

    it('a cache HIT still returns the same product data as the original fetch', async function() {
        adapters.searchAllMarketplaces.mockResolvedValue({ results: [fakeProviderProduct()], failures: [] });

        const first = await productService.searchAndPersist('iphone 16');
        const second = await productService.searchAndPersist('iphone 16');

        expect(second.products).toHaveLength(1);
        expect(second.products[0].externalId).toBe(first.products[0].externalId);
        expect(second.products[0].currentPrice).toBe(first.products[0].currentPrice);
    });

    it('a DIFFERENT query is a separate cache entry - triggers its own fetch', async function() {
        adapters.searchAllMarketplaces.mockResolvedValue({ results: [fakeProviderProduct()], failures: [] });

        await productService.searchAndPersist('iphone 16');
        await productService.searchAndPersist('samsung galaxy');

        expect(adapters.searchAllMarketplaces).toHaveBeenCalledTimes(2);
    });

    it('the cache key ignores case and surrounding whitespace - "iPhone 16" and "  iphone 16  " share one entry', async function() {
        adapters.searchAllMarketplaces.mockResolvedValue({ results: [fakeProviderProduct()], failures: [] });

        await productService.searchAndPersist('iPhone 16');
        await productService.searchAndPersist('  iphone 16  ');

        expect(adapters.searchAllMarketplaces).toHaveBeenCalledTimes(1);
    });

    it('sortBy/platform in options do NOT affect the cache key - same query, different options, still one fetch', async function() {
        adapters.searchAllMarketplaces.mockResolvedValue({ results: [fakeProviderProduct()], failures: [] });

        await productService.searchAndPersist('iphone 16', { sortBy: 'price_asc', platform: 'amazon' });
        await productService.searchAndPersist('iphone 16', { sortBy: 'rating', platform: 'flipkart' });

        expect(adapters.searchAllMarketplaces).toHaveBeenCalledTimes(1);
    });

    it('is keyed under "search:<query>" - the exact shape product.routes.js\'s (removed) HTTP cache used to use, kept for continuity', async function() {
        adapters.searchAllMarketplaces.mockResolvedValue({ results: [fakeProviderProduct()], failures: [] });

        await productService.searchAndPersist('iphone 16');

        expect(cache.getOrSet).toHaveBeenCalledWith('search:iphone 16', config.cacheTtl.search, expect.any(Function));
    });
});
