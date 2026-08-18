// tests/integration/services/adminProduct.service.test.js
//
// Integration test for adminProduct.service.js - a thin CRUD wrapper
// over adminProduct.repository.js, so this focuses on what the service
// actually adds: 404 translation for update/delete/get on a nonexistent
// id (the repository just returns null; ApiError.notFound is a service-
// layer concern).

'use strict';

const mongoose = require('mongoose');
const config = require('../../../src/config/env');
const AdminProduct = require('../../../src/models/AdminProduct.model');
const adminProductService = require('../../../src/services/adminProduct.service');

const PREFIX = 'ADMINSVCTEST_';

async function cleanup() {
    await AdminProduct.deleteMany({ title: { $regex: '^' + PREFIX } });
}

function makeData(overrides) {
    const id = Math.random().toString(36).slice(2);
    return Object.assign({
            title: PREFIX + 'Product ' + id,
            category: 'AdminSvcTestDefault',
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

describe('createProduct', function() {
    it('creates and returns the new document', async function() {
        const product = await adminProductService.createProduct(makeData({ title: PREFIX + 'New Thing' }));
        expect(product._id).toBeDefined();
        expect(product.title).toBe(PREFIX + 'New Thing');
    });

    it('accepts no url at all - it is optional', async function() {
        const product = await adminProductService.createProduct(makeData());
        expect(product.url).toBeNull();
    });

    it('accepts a url from a supported marketplace', async function() {
        const product = await adminProductService.createProduct(makeData({ url: 'https://www.amazon.in/dp/ADMINSVCTEST1' }));
        expect(product.url).toBe('https://www.amazon.in/dp/ADMINSVCTEST1');
    });

    it('rejects a url from an unsupported marketplace with a 400', async function() {
        await expect(
            adminProductService.createProduct(makeData({ url: 'https://www.ebay.com/itm/123' }))
        ).rejects.toMatchObject({ statusCode: 400 });
    });
});

describe('listProducts', function() {
    it('paginates and includes hidden entries (admin view)', async function() {
        // Scoped by category - listProducts with no filter counts the
        // WHOLE collection, which other test files run in parallel
        // against this same shared test database also write to.
        const category = 'AdminSvcTestListing';
        await adminProductService.createProduct(makeData({ category, status: 'active' }));
        await adminProductService.createProduct(makeData({ category, status: 'hidden' }));

        const result = await adminProductService.listProducts({ page: 1, limit: 20, category });

        expect(result.total).toBe(2);
        expect(result.products).toHaveLength(2);
    });
});

describe('getProduct', function() {
    it('rejects a nonexistent id with a 404', async function() {
        const fakeId = new mongoose.Types.ObjectId().toString();
        await expect(adminProductService.getProduct(fakeId)).rejects.toMatchObject({ statusCode: 404 });
    });

    it('finds a hidden entry too (admin view, unlike public category browsing)', async function() {
        const created = await adminProductService.createProduct(makeData({ status: 'hidden' }));
        const found = await adminProductService.getProduct(created._id.toString());
        expect(found._id.toString()).toBe(created._id.toString());
    });
});

describe('updateProduct', function() {
    it('rejects a nonexistent id with a 404', async function() {
        const fakeId = new mongoose.Types.ObjectId().toString();
        await expect(adminProductService.updateProduct(fakeId, { price: 500 })).rejects.toMatchObject({ statusCode: 404 });
    });

    it('applies the update for a real id', async function() {
        const created = await adminProductService.createProduct(makeData({ price: 1000 }));
        const updated = await adminProductService.updateProduct(created._id.toString(), { price: 2000 });
        expect(updated.price).toBe(2000);
    });

    it('rejects a url update from an unsupported marketplace with a 400', async function() {
        const created = await adminProductService.createProduct(makeData());
        await expect(
            adminProductService.updateProduct(created._id.toString(), { url: 'https://www.ebay.com/itm/123' })
        ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('accepts a valid url update, turning a plain-search card into a compare-url one', async function() {
        const created = await adminProductService.createProduct(makeData());
        const updated = await adminProductService.updateProduct(created._id.toString(), { url: 'https://www.amazon.in/dp/ADMINSVCTEST2' });
        expect(updated.url).toBe('https://www.amazon.in/dp/ADMINSVCTEST2');
    });
});

describe('deleteProduct', function() {
    it('rejects a nonexistent id with a 404', async function() {
        const fakeId = new mongoose.Types.ObjectId().toString();
        await expect(adminProductService.deleteProduct(fakeId)).rejects.toMatchObject({ statusCode: 404 });
    });

    it('deletes a real entry', async function() {
        const created = await adminProductService.createProduct(makeData());
        await adminProductService.deleteProduct(created._id.toString());
        expect(await AdminProduct.findById(created._id)).toBeNull();
    });
});
