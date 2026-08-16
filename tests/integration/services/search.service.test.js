// tests/integration/services/search.service.test.js
//
// Mocks product.service.js (one layer down from search.service.js, not
// raw adapters) - keeps this test focused on what search.service.js
// actually adds on top: sorting and history recording. Persistence
// logic is already covered by product.service.test.js.

'use strict';

jest.mock('../../../src/services/product.service');

const mongoose = require('mongoose');
const config = require('../../../src/config/env');
const User = require('../../../src/models/User.model');
const SearchHistory = require('../../../src/models/SearchHistory.model');
const productService = require('../../../src/services/product.service');
const searchService = require('../../../src/services/search.service');

const TEST_EMAIL = 'svctest-search@example.com';

let user;

beforeAll(async function() {
    await mongoose.connect(config.mongoUri);
});

afterAll(async function() {
    await mongoose.disconnect();
});

beforeEach(async function() {
    jest.clearAllMocks();
    await User.deleteMany({ email: TEST_EMAIL });
    user = await User.create({ name: 'Search Service Test', email: TEST_EMAIL, password: 'plaintext123' });
    await SearchHistory.deleteMany({ userId: user._id });
});

describe('getSortedProducts (pure function - no mocking needed)', function() {
    const fakeProducts = [
        { currentPrice: 500, rating: { average: 3.5 } },
        { currentPrice: 100, rating: { average: 4.8 } },
        { currentPrice: 900, rating: { average: 4.0 } },
    ];

    it('sorts ascending by price', function() {
        const sorted = searchService.getSortedProducts(fakeProducts, 'price_asc');
        expect(sorted.map(function(p) { return p.currentPrice; })).toEqual([100, 500, 900]);
    });

    it('sorts descending by price', function() {
        const sorted = searchService.getSortedProducts(fakeProducts, 'price_desc');
        expect(sorted.map(function(p) { return p.currentPrice; })).toEqual([900, 500, 100]);
    });

    it('sorts by rating, highest first', function() {
        const sorted = searchService.getSortedProducts(fakeProducts, 'rating');
        expect(sorted.map(function(p) { return p.rating.average; })).toEqual([4.8, 4.0, 3.5]);
    });

    it('does not mutate the original array', function() {
        searchService.getSortedProducts(fakeProducts, 'price_asc');
        expect(fakeProducts[0].currentPrice).toBe(500); // unchanged order
    });

    it('leaves order unchanged when no sortBy is given', function() {
        const sorted = searchService.getSortedProducts(fakeProducts);
        expect(sorted.map(function(p) { return p.currentPrice; })).toEqual([500, 100, 900]);
    });
});

describe('runSearch - guest vs authenticated branching', function() {
    it('a guest search (no userId) does NOT record history', async function() {
        productService.searchAndPersist.mockResolvedValue({
            products: [{ currentPrice: 100 }],
            marketplaceFailures: [],
        });

        await searchService.runSearch('laptop', null);

        const historyCount = await SearchHistory.countDocuments({ userId: user._id });
        expect(historyCount).toBe(0);
    });

    it('an authenticated search DOES record history', async function() {
        productService.searchAndPersist.mockResolvedValue({
            products: [{ currentPrice: 100 }, { currentPrice: 200 }],
            marketplaceFailures: [],
        });

        await searchService.runSearch('laptop', user._id);

        const history = await searchService.getSearchHistory(user._id);
        expect(history).toHaveLength(1);
        expect(history[0].query).toBe('laptop');
        expect(history[0].resultCount).toBe(2);
    });

    it('repeating the same authenticated search MERGES into one row, incrementing searchCount', async function() {
        productService.searchAndPersist.mockResolvedValue({ products: [{ currentPrice: 100 }], marketplaceFailures: [] });

        await searchService.runSearch('laptop', user._id);
        await searchService.runSearch('laptop', user._id);

        const history = await searchService.getSearchHistory(user._id);
        expect(history).toHaveLength(1);
        expect(history[0].searchCount).toBe(2);
    });

    it('history-recording failure does not fail the search response itself', async function() {
        productService.searchAndPersist.mockResolvedValue({ products: [{ currentPrice: 100 }], marketplaceFailures: [] });

        // Force the (real) repository call inside recordSearch to fail, by
        // passing a userId that is not a valid ObjectId shape - this should
        // be caught internally and logged, not thrown back to the caller.
        const result = await searchService.runSearch('laptop', 'not-a-valid-object-id');

        expect(result.products).toHaveLength(1); // search itself still succeeded
    });
});

describe('runSearch applies sorting to the persisted products', function() {
    it('sorts persisted products by the requested sortBy option', async function() {
        productService.searchAndPersist.mockResolvedValue({
            products: [{ currentPrice: 900 }, { currentPrice: 100 }, { currentPrice: 500 }],
            marketplaceFailures: [],
        });

        const result = await searchService.runSearch('laptop', null, { sortBy: 'price_asc' });
        expect(result.products.map(function(p) { return p.currentPrice; })).toEqual([100, 500, 900]);
    });
});

describe('runSearch - pagination', function() {
    function fakeProducts(count) {
        const products = [];
        for (let i = 0; i < count; i++) products.push({ currentPrice: i });
        return products;
    }

    it('defaults to page 1 with config.search.defaultLimit results', async function() {
        productService.searchAndPersist.mockResolvedValue({ products: fakeProducts(30), marketplaceFailures: [] });

        const result = await searchService.runSearch('laptop', null);

        expect(result.page).toBe(1);
        expect(result.limit).toBe(config.search.defaultLimit);
        expect(result.products).toHaveLength(config.search.defaultLimit);
        expect(result.total).toBe(30);
        expect(result.totalPages).toBe(Math.ceil(30 / config.search.defaultLimit));
    });

    it('returns the requested page, a disjoint slice from page 1', async function() {
        productService.searchAndPersist.mockResolvedValue({ products: fakeProducts(25), marketplaceFailures: [] });

        const page1 = await searchService.runSearch('laptop', null, { page: 1, limit: 10 });
        const page2 = await searchService.runSearch('laptop', null, { page: 2, limit: 10 });
        const page3 = await searchService.runSearch('laptop', null, { page: 3, limit: 10 });

        expect(page1.products).toHaveLength(10);
        expect(page2.products).toHaveLength(10);
        expect(page3.products).toHaveLength(5); // remainder
        expect(page1.products[0].currentPrice).not.toBe(page2.products[0].currentPrice);
        expect(page1.totalPages).toBe(3);
    });

    it('total/resultCount reflects EVERY result, not just the current page', async function() {
        productService.searchAndPersist.mockResolvedValue({ products: fakeProducts(47), marketplaceFailures: [] });

        const result = await searchService.runSearch('laptop', null, { page: 2, limit: 10 });

        expect(result.products).toHaveLength(10);
        expect(result.total).toBe(47);
    });

    it('records search history against the TOTAL count, not the page size', async function() {
        productService.searchAndPersist.mockResolvedValue({ products: fakeProducts(47), marketplaceFailures: [] });

        await searchService.runSearch('laptop', user._id, { page: 1, limit: 10 });

        const history = await searchService.getSearchHistory(user._id);
        expect(history[0].resultCount).toBe(47); // not 10
    });

    it('an out-of-range page returns an empty products array, not an error', async function() {
        productService.searchAndPersist.mockResolvedValue({ products: fakeProducts(5), marketplaceFailures: [] });

        const result = await searchService.runSearch('laptop', null, { page: 99, limit: 10 });

        expect(result.products).toEqual([]);
        expect(result.total).toBe(5);
    });

    it('pagination is applied AFTER sorting, so page 2 continues in sorted order', async function() {
        const products = [];
        for (let i = 20; i >= 1; i--) products.push({ currentPrice: i }); // descending input order
        productService.searchAndPersist.mockResolvedValue({ products, marketplaceFailures: [] });

        const page2 = await searchService.runSearch('laptop', null, { sortBy: 'price_asc', page: 2, limit: 10 });

        expect(page2.products.map(function(p) { return p.currentPrice; })).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    });
});

describe('deleteSearchHistoryItem', function() {
    it('deletes an entry belonging to the caller', async function() {
        productService.searchAndPersist.mockResolvedValue({ products: [{ currentPrice: 100 }], marketplaceFailures: [] });
        await searchService.runSearch('laptop', user._id);

        const history = await searchService.getSearchHistory(user._id);
        const result = await searchService.deleteSearchHistoryItem(history[0]._id, user._id);

        expect(result.deletedCount).toBe(1);
    });
});