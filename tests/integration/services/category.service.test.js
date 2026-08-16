// tests/integration/services/category.service.test.js
//
// Integration test for category.service.js - real DB, no mocking (same
// approach as product.repository.category.test.js, one layer up).

'use strict';

const mongoose = require('mongoose');
const config = require('../../../src/config/env');
const Product = require('../../../src/models/Product.model');
const categoryService = require('../../../src/services/category.service');

const MARKETPLACE = 'amazon';
const PREFIX = 'CATSVCTEST_';

async function cleanup() {
    await Product.deleteMany({ marketplace: MARKETPLACE, externalId: { $regex: '^' + PREFIX } });
}

function makeProduct(overrides) {
    const id = PREFIX + Math.random().toString(36).slice(2);
    return Object.assign({
            marketplace: MARKETPLACE,
            externalId: id,
            title: 'Category Service Test Product ' + id,
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

describe('listCategories', function() {
    it('surfaces a real category through to the top', async function() {
        await Product.create(makeProduct({ category: 'CatSvcTestToys' }));

        const categories = await categoryService.listCategories();
        expect(categories.some(function(c) { return c.category === 'CatSvcTestToys'; })).toBe(true);
    });
});

describe('getProductsByCategory', function() {
    it('rejects a blank category with a 400', async function() {
        await expect(categoryService.getProductsByCategory('   ', {})).rejects.toMatchObject({ statusCode: 400 });
    });

    it('returns paginated products with correct total/totalPages', async function() {
        await Product.create([
            makeProduct({ category: 'CatSvcTestGadgets' }),
            makeProduct({ category: 'CatSvcTestGadgets' }),
            makeProduct({ category: 'CatSvcTestGadgets' }),
        ]);

        const result = await categoryService.getProductsByCategory('CatSvcTestGadgets', { page: 1, limit: 2 });

        expect(result.products).toHaveLength(2);
        expect(result.total).toBe(3);
        expect(result.totalPages).toBe(2);
        expect(result.page).toBe(1);
    });

    it('defaults to page 1, limit 20 when not specified', async function() {
        await Product.create(makeProduct({ category: 'CatSvcTestDefaults' }));

        const result = await categoryService.getProductsByCategory('CatSvcTestDefaults', {});

        expect(result.page).toBe(1);
        expect(result.limit).toBe(20);
    });

    it('trims the category before querying', async function() {
        await Product.create(makeProduct({ category: 'CatSvcTestTrimmed' }));

        const result = await categoryService.getProductsByCategory('  CatSvcTestTrimmed  ', {});

        expect(result.products).toHaveLength(1);
        expect(result.category).toBe('CatSvcTestTrimmed');
    });
});
