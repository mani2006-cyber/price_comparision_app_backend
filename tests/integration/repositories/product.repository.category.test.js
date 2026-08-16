// tests/integration/repositories/product.repository.category.test.js
//
// Integration tests for the category-browsing repository functions
// (findDistinctCategories, findByCategory, countByCategory). Separate
// file from product.repository.test.js (which owns upsertFromProviderData)
// since this is a genuinely different concern - reads over the
// already-persisted catalog, never a write path.

'use strict';

const mongoose = require('mongoose');
const config = require('../../../src/config/env');
const Product = require('../../../src/models/Product.model');
const productRepository = require('../../../src/repositories/product.repository');

const MARKETPLACE = 'amazon';
const PREFIX = 'CATREPOTEST_';

async function cleanup() {
    await Product.deleteMany({ marketplace: MARKETPLACE, externalId: { $regex: '^' + PREFIX } });
}

function makeProduct(overrides) {
    const id = PREFIX + Math.random().toString(36).slice(2);
    return Object.assign({
            marketplace: MARKETPLACE,
            externalId: id,
            title: 'Category Repo Test Product ' + id,
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

describe('findDistinctCategories', function() {
    it('returns each distinct category with an accurate count, excluding null', async function() {
        await Product.create([
            makeProduct({ category: 'CatRepoTestHeadphones', currentPrice: 1000 }),
            makeProduct({ category: 'CatRepoTestHeadphones', currentPrice: 2000 }),
            makeProduct({ category: 'CatRepoTestShoes', currentPrice: 3000 }),
            makeProduct({ category: null }),
        ]);

        const categories = await productRepository.findDistinctCategories();
        const byName = {};
        categories.forEach(function(c) { byName[c.category] = c.count; });

        expect(byName.CatRepoTestHeadphones).toBe(2);
        expect(byName.CatRepoTestShoes).toBe(1);
        expect(byName[null]).toBeUndefined();
    });
});

describe('findByCategory / countByCategory', function() {
    it('matches case-insensitively (collation), same category typed differently', async function() {
        await Product.create([
            makeProduct({ category: 'CatRepoTestElectronics' }),
        ]);

        const found = await productRepository.findByCategory('catrepotestELECTRONICS', {});
        const count = await productRepository.countByCategory('catrepotestELECTRONICS');

        expect(found).toHaveLength(1);
        expect(count).toBe(1);
    });

    it('paginates - page 1 and page 2 return disjoint, correctly-sized slices', async function() {
        await Product.create([
            makeProduct({ category: 'CatRepoTestBooks', currentPrice: 100 }),
            makeProduct({ category: 'CatRepoTestBooks', currentPrice: 200 }),
            makeProduct({ category: 'CatRepoTestBooks', currentPrice: 300 }),
        ]);

        const page1 = await productRepository.findByCategory('CatRepoTestBooks', { page: 1, limit: 2 });
        const page2 = await productRepository.findByCategory('CatRepoTestBooks', { page: 2, limit: 2 });

        expect(page1).toHaveLength(2);
        expect(page2).toHaveLength(1);
        const page1Ids = page1.map(function(p) { return p._id.toString(); });
        const page2Ids = page2.map(function(p) { return p._id.toString(); });
        expect(page1Ids).not.toEqual(expect.arrayContaining(page2Ids));
    });

    it('sorts by price ascending/descending on request', async function() {
        await Product.create([
            makeProduct({ category: 'CatRepoTestSort', currentPrice: 300 }),
            makeProduct({ category: 'CatRepoTestSort', currentPrice: 100 }),
            makeProduct({ category: 'CatRepoTestSort', currentPrice: 200 }),
        ]);

        const asc = await productRepository.findByCategory('CatRepoTestSort', { sortBy: 'price_asc', limit: 10 });
        const desc = await productRepository.findByCategory('CatRepoTestSort', { sortBy: 'price_desc', limit: 10 });

        expect(asc.map(function(p) { return p.currentPrice; })).toEqual([100, 200, 300]);
        expect(desc.map(function(p) { return p.currentPrice; })).toEqual([300, 200, 100]);
    });

    it('returns nothing for a category with no products', async function() {
        const found = await productRepository.findByCategory('CatRepoTestNonexistent', {});
        const count = await productRepository.countByCategory('CatRepoTestNonexistent');

        expect(found).toHaveLength(0);
        expect(count).toBe(0);
    });
});
