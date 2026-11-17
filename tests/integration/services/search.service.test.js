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

describe('runSearch - complete result set', function() {
    function fakeProducts(count) {
        const products = [];
        for (let i = 0; i < count; i++) products.push({ currentPrice: i });
        return products;
    }

    it('returns the default page and pagination metadata for the complete result set', async function() {
        productService.searchAndPersist.mockResolvedValue({ products: fakeProducts(30), marketplaceFailures: [] });

        const result = await searchService.runSearch('laptop', null);

        expect(result.products).toHaveLength(20);
        expect(result.total).toBe(30);
        expect(result.page).toBe(1);
        expect(result.limit).toBe(20);
        expect(result.totalPages).toBe(2);
    });

    it('sorts the complete result set before returning the requested page', async function() {
        productService.searchAndPersist.mockResolvedValue({ products: fakeProducts(30), marketplaceFailures: [] });

        const result = await searchService.runSearch('laptop', null, {
            sortBy: 'price_desc',
            page: 2,
            limit: 10,
        });

        expect(result.products.map(function(product) { return product.currentPrice; }))
            .toEqual([19, 18, 17, 16, 15, 14, 13, 12, 11, 10]);
        expect(result.total).toBe(30);
        expect(result.page).toBe(2);
        expect(result.limit).toBe(10);
        expect(result.totalPages).toBe(3);
        expect(productService.searchAndPersist).toHaveBeenCalledWith('laptop', {
            sortBy: 'price_desc',
            platform: undefined,
        });
    });

    it('keeps all marketplace results when some titles do not literally contain the query', async function() {
        const products = [{ title: 'Gaming laptop', marketplace: 'flipkart' }];
        for (let i = 0; i < 23; i++) {
            products.push({ title: 'Notebook computer ' + i, marketplace: 'flipkart' });
        }
        productService.searchAndPersist.mockResolvedValue({ products, marketplaceFailures: [] });

        const result = await searchService.runSearch('laptop', null, { page: 2, limit: 10 });

        expect(result.total).toBe(24);
        expect(result.products).toHaveLength(10);
        expect(result.products.some(function(product) { return product.title.indexOf('Notebook computer') === 0; })).toBe(true);
    });

    it('records search history against the TOTAL count, not the page size', async function() {
        productService.searchAndPersist.mockResolvedValue({ products: fakeProducts(47), marketplaceFailures: [] });

        await searchService.runSearch('laptop', user._id);

        const history = await searchService.getSearchHistory(user._id);
        expect(history[0].resultCount).toBe(47); // not 10
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

