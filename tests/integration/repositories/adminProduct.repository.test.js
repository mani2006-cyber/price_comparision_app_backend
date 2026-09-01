// tests/integration/repositories/adminProduct.repository.test.js
//
// Integration test for adminProduct.repository.js - the write side
// (admin CRUD) and the public "active only" read side used by category
// browsing both live here, so both are covered.

'use strict';

const mongoose = require('mongoose');
const config = require('../../../src/config/env');
const AdminProduct = require('../../../src/models/AdminProduct.model');
const adminProductRepository = require('../../../src/repositories/adminProduct.repository');

const PREFIX = 'ADMINREPOTEST_';

async function cleanup() {
    await AdminProduct.deleteMany({ title: { $regex: '^' + PREFIX } });
}

function makeData(overrides) {
    const id = Math.random().toString(36).slice(2);
    return Object.assign({
            title: PREFIX + 'Product ' + id,
            category: 'AdminRepoTestDefault',
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

beforeEach(cleanup);
afterEach(cleanup);

describe('create / findById', function() {
    it('creates an entry and auto-generates a slug', async function() {
        const created = await adminProductRepository.create(makeData({ title: PREFIX + 'Sony Headphones' }));

        expect(created.slug).toContain('sony-headphones');

        const found = await adminProductRepository.findById(created._id);
        expect(found.title).toBe(created.title);
    });
});

describe('updateById / deleteById', function() {
    it('updates the given fields only', async function() {
        const created = await adminProductRepository.create(makeData({ price: 1000 }));

        const updated = await adminProductRepository.updateById(created._id, { price: 1500 });

        expect(updated.price).toBe(1500);
        expect(updated.title).toBe(created.title); // untouched
    });

    it('returns null for a nonexistent id', async function() {
        const fakeId = new mongoose.Types.ObjectId();
        expect(await adminProductRepository.updateById(fakeId, { price: 500 })).toBeNull();
        expect(await adminProductRepository.deleteById(fakeId)).toBeNull();
    });

    it('deleteById actually removes the document', async function() {
        const created = await adminProductRepository.create(makeData());

        await adminProductRepository.deleteById(created._id);

        expect(await AdminProduct.findById(created._id)).toBeNull();
    });
});

describe('findAll / countAll - admin view, unfiltered by status', function() {
    it('includes both active and hidden entries', async function() {
        // Scoped by category in the query below - an UNFILTERED findAll/
        // countAll counts the whole collection, which other test files
        // running in parallel against this same shared test database
        // also write to.
        const category = 'AdminRepoTestStatusMix';
        await adminProductRepository.create(makeData({ category, status: 'active' }));
        await adminProductRepository.create(makeData({ category, status: 'hidden' }));

        const all = await adminProductRepository.findAll({ page: 1, limit: 20, category });
        const count = await adminProductRepository.countAll({ category });

        expect(all).toHaveLength(2);
        expect(count).toBe(2);
    });

    it('filters by category when given', async function() {
        await adminProductRepository.create(makeData({ category: 'AdminRepoTestA' }));
        await adminProductRepository.create(makeData({ category: 'AdminRepoTestB' }));

        const filtered = await adminProductRepository.findAll({ category: 'AdminRepoTestA' });
        expect(filtered).toHaveLength(1);
        expect(filtered[0].category).toBe('AdminRepoTestA');
    });
});

describe('findActiveById - public "click through" lookup', function() {
    it('finds an active entry', async function() {
        const created = await adminProductRepository.create(makeData({ status: 'active' }));
        const found = await adminProductRepository.findActiveById(created._id);
        expect(found).not.toBeNull();
    });

    it('does NOT find a hidden entry, even by exact id', async function() {
        const created = await adminProductRepository.create(makeData({ status: 'hidden' }));
        const found = await adminProductRepository.findActiveById(created._id);
        expect(found).toBeNull();
    });
});

describe('findDistinctCategories / findByCategory / countByCategory - active only', function() {
    it('excludes a hidden entry from all three', async function() {
        await adminProductRepository.create(makeData({ category: 'AdminRepoTestHidden', status: 'hidden' }));

        const categories = await adminProductRepository.findDistinctCategories();
        expect(categories.find(function(c) { return c.category === 'AdminRepoTestHidden'; })).toBeUndefined();

        expect(await adminProductRepository.findByCategory('AdminRepoTestHidden', {})).toHaveLength(0);
        expect(await adminProductRepository.countByCategory('AdminRepoTestHidden')).toBe(0);
    });

    it('groups categories case-insensitively, matching the case-insensitive detail query', async function() {
        await adminProductRepository.create(makeData({ category: 'AdminRepoTestFold' }));
        await adminProductRepository.create(makeData({ category: 'adminrepotestfold' }));

        const categories = await adminProductRepository.findDistinctCategories();
        const matches = categories.filter(function(c) { return c.category.toLowerCase() === 'adminrepotestfold'; });

        expect(matches).toHaveLength(1);
        expect(matches[0].count).toBe(2);
    });

    it('sorts by price when requested', async function() {
        await adminProductRepository.create(makeData({ category: 'AdminRepoTestSort', price: 300 }));
        await adminProductRepository.create(makeData({ category: 'AdminRepoTestSort', price: 100 }));
        await adminProductRepository.create(makeData({ category: 'AdminRepoTestSort', price: 200 }));

        const sorted = await adminProductRepository.findByCategory('AdminRepoTestSort', { sortBy: 'price_asc' });
        expect(sorted.map(function(p) { return p.price; })).toEqual([100, 200, 300]);
    });
});
