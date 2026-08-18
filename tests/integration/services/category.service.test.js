// tests/integration/services/category.service.test.js
//
// Integration test for category.service.js. listCategories/
// getProductsByCategory hit the real DB (AdminProduct) - no mocking
// needed, same as the old Product-backed version this replaces.
// getProductListings mocks search.service.js AND compare.service.js (one
// layer down) - it's only a pass-through to one or the other plus an
// AdminProduct lookup (branching on whether the product has a url - see
// category.service.js's own comment), and runSearch/compareByUrl's own
// behavior is already covered by their respective test files.

'use strict';

jest.mock('../../../src/services/search.service');
jest.mock('../../../src/services/compare.service');

const mongoose = require('mongoose');
const config = require('../../../src/config/env');
const AdminProduct = require('../../../src/models/AdminProduct.model');
const searchService = require('../../../src/services/search.service');
const compareService = require('../../../src/services/compare.service');
const categoryService = require('../../../src/services/category.service');

const PREFIX = 'CATSVCTEST_';

async function cleanup() {
    await AdminProduct.deleteMany({ title: { $regex: '^' + PREFIX } });
}

function makeAdminProduct(overrides) {
    const id = Math.random().toString(36).slice(2);
    return Object.assign({
            title: PREFIX + 'Product ' + id,
            category: 'CatSvcTestDefault',
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

beforeEach(async function() {
    jest.clearAllMocks();
    await cleanup();
});
afterEach(cleanup);

describe('listCategories', function() {
    it('surfaces a real category through to the top', async function() {
        await AdminProduct.create(makeAdminProduct({ category: 'CatSvcTestToys' }));

        const categories = await categoryService.listCategories();
        expect(categories.some(function(c) { return c.category === 'CatSvcTestToys'; })).toBe(true);
    });

    it('excludes a hidden entry from both the list and its count', async function() {
        await AdminProduct.create([
            makeAdminProduct({ category: 'CatSvcTestHidden', status: 'active' }),
            makeAdminProduct({ category: 'CatSvcTestHidden', status: 'hidden' }),
        ]);

        const categories = await categoryService.listCategories();
        const entry = categories.find(function(c) { return c.category === 'CatSvcTestHidden'; });
        expect(entry.count).toBe(1);
    });
});

describe('getProductsByCategory', function() {
    it('rejects a blank category with a 400', async function() {
        await expect(categoryService.getProductsByCategory('   ', {})).rejects.toMatchObject({ statusCode: 400 });
    });

    it('returns paginated products with correct total/totalPages', async function() {
        await AdminProduct.create([
            makeAdminProduct({ category: 'CatSvcTestGadgets' }),
            makeAdminProduct({ category: 'CatSvcTestGadgets' }),
            makeAdminProduct({ category: 'CatSvcTestGadgets' }),
        ]);

        const result = await categoryService.getProductsByCategory('CatSvcTestGadgets', { page: 1, limit: 2 });

        expect(result.products).toHaveLength(2);
        expect(result.total).toBe(3);
        expect(result.totalPages).toBe(2);
        expect(result.page).toBe(1);
    });

    it('defaults to page 1, limit config.category.defaultLimit when not specified', async function() {
        await AdminProduct.create(makeAdminProduct({ category: 'CatSvcTestDefaults' }));

        const result = await categoryService.getProductsByCategory('CatSvcTestDefaults', {});

        expect(result.page).toBe(1);
        expect(result.limit).toBe(config.category.defaultLimit);
    });

    it('trims the category before querying', async function() {
        await AdminProduct.create(makeAdminProduct({ category: 'CatSvcTestTrimmed' }));

        const result = await categoryService.getProductsByCategory('  CatSvcTestTrimmed  ', {});

        expect(result.products).toHaveLength(1);
        expect(result.category).toBe('CatSvcTestTrimmed');
    });

    it('excludes a hidden entry from the results', async function() {
        await AdminProduct.create(makeAdminProduct({ category: 'CatSvcTestHiddenList', status: 'hidden' }));

        const result = await categoryService.getProductsByCategory('CatSvcTestHiddenList', {});

        expect(result.products).toHaveLength(0);
        expect(result.total).toBe(0);
    });
});

describe('getProductListings', function() {
    it('throws 404 for an id that does not exist', async function() {
        const fakeId = new mongoose.Types.ObjectId().toString();
        await expect(categoryService.getProductListings(fakeId, {})).rejects.toMatchObject({ statusCode: 404 });
    });

    it('throws 404 for a hidden product - not clickable even if the id is known', async function() {
        const hidden = await AdminProduct.create(makeAdminProduct({ status: 'hidden' }));
        await expect(categoryService.getProductListings(hidden._id.toString(), {})).rejects.toMatchObject({ statusCode: 404 });
    });

    describe('no url set (today\'s seeded catalog)', function() {
        it('runs a live search keyed by the admin product title, WITHOUT a userId (never records search history)', async function() {
            const product = await AdminProduct.create(makeAdminProduct({ title: PREFIX + 'Noise Cancelling Headphones' }));
            searchService.runSearch.mockResolvedValue({ products: [{ currentPrice: 999 }], total: 1, page: 1, limit: 6, totalPages: 1, marketplaceFailures: [] });

            const result = await categoryService.getProductListings(product._id.toString(), { page: 1, limit: 6 });

            expect(searchService.runSearch).toHaveBeenCalledWith(product.title, null, { page: 1, limit: 6 });
            expect(compareService.compareByUrl).not.toHaveBeenCalled();
            expect(result.adminProduct._id.toString()).toBe(product._id.toString());
            expect(result.listings.products).toHaveLength(1);
            expect(result.comparison).toBeNull();
        });
    });

    describe('url set', function() {
        it('runs the url through compareByUrl instead of searching by title', async function() {
            const product = await AdminProduct.create(makeAdminProduct({ url: 'https://www.amazon.in/dp/CATSVCCLICK1' }));
            compareService.compareByUrl.mockResolvedValue({
                originalUrl: product.url,
                detectedMarketplace: 'amazon',
                matchesFound: 1,
                results: [{ currentPrice: 999 }],
                similarProducts: [],
                marketplaceFailures: [],
                aiSummary: null,
            });

            const result = await categoryService.getProductListings(product._id.toString(), { page: 1, limit: 6 });

            expect(compareService.compareByUrl).toHaveBeenCalledWith(product.url, { page: 1, limit: 6 });
            expect(searchService.runSearch).not.toHaveBeenCalled();
            expect(result.adminProduct._id.toString()).toBe(product._id.toString());
            expect(result.comparison.results).toHaveLength(1);
            expect(result.listings).toBeNull();
        });
    });
});
