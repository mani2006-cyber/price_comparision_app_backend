// tests/integration/services/product.service.test.js
//
// Tests product.service.js with the ENTIRE adapters module mocked -
// letting this hit real marketplaces would be slow, flaky (Flipkart's
// 401s and scraping variance have been a recurring theme throughout
// this project), and burns real RapidAPI quota on every test run.
// Product persistence is still REAL (test MongoDB) - only the network-
// facing adapter layer is faked.

'use strict';

jest.mock('../../../src/adapters');

const mongoose = require('mongoose');
const config = require('../../../src/config/env');
const Product = require('../../../src/models/Product.model');
const adapters = require('../../../src/adapters');
const productService = require('../../../src/services/product.service');
const ApiError = require('../../../src/utils/ApiError');

function fakeProviderProduct(overrides) {
    return Object.assign({
            marketplace: 'amazon',
            externalId: 'SVCTEST1',
            title: 'Mocked Test Product',
            currentPrice: 9999,
            rawUrl: 'https://www.amazon.in/dp/SVCTEST1',
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
    await Product.deleteMany({ externalId: { $regex: /^SVCTEST/ } });
});

describe('searchAndPersist', function() {
    it('persists every result returned by the mocked adapter search', async function() {
        adapters.searchAllMarketplaces.mockResolvedValue({
            results: [fakeProviderProduct(), fakeProviderProduct({ externalId: 'SVCTEST2', marketplace: 'flipkart' })],
            failures: [],
        });

        const result = await productService.searchAndPersist('test query');

        expect(result.products).toHaveLength(2);
        expect(result.products[0]._id).toBeDefined();
    });

    it('re-running the same search upserts onto the SAME documents, not duplicates', async function() {
        adapters.searchAllMarketplaces.mockResolvedValue({ results: [fakeProviderProduct()], failures: [] });

        await productService.searchAndPersist('test query');
        const countBefore = await Product.countDocuments({ externalId: 'SVCTEST1' });

        await productService.searchAndPersist('test query');
        const countAfter = await Product.countDocuments({ externalId: 'SVCTEST1' });

        expect(countBefore).toBe(1);
        expect(countAfter).toBe(1);
    });

    it('a single malformed result does not fail the entire batch', async function() {
        adapters.searchAllMarketplaces.mockResolvedValue({
            results: [
                fakeProviderProduct({ externalId: 'SVCTEST3' }), // valid
                { marketplace: 'amazon', externalId: 'SVCTEST_BAD' }, // missing required fields - title, currentPrice, rawUrl, fetchedVia
                fakeProviderProduct({ externalId: 'SVCTEST4' }), // valid
            ],
            failures: [],
        });

        const result = await productService.searchAndPersist('test query');

        // Only the 2 valid ones persisted - the malformed one was skipped,
        // not allowed to crash the whole batch.
        expect(result.products).toHaveLength(2);
    });

    it('passes through marketplaceFailures reported by the adapter layer', async function() {
        adapters.searchAllMarketplaces.mockResolvedValue({
            results: [],
            failures: [{ marketplace: 'flipkart', message: 'RapidAPI request failed with status 401' }],
        });

        const result = await productService.searchAndPersist('test query');
        expect(result.marketplaceFailures).toHaveLength(1);
        expect(result.marketplaceFailures[0].marketplace).toBe('flipkart');
    });
});

describe('getProductDetail', function() {
    it('returns the product for a valid id', async function() {
        const created = await Product.create(fakeProviderProduct());

        const found = await productService.getProductDetail(created._id);
        expect(found._id.toString()).toBe(created._id.toString());
    });

    it('throws a 404 for a well-formed but nonexistent id', async function() {
        await expect(productService.getProductDetail('000000000000000000000000')).rejects.toMatchObject({
            statusCode: 404,
        });
    });
});

describe('refreshProductByLink', function() {
    it('detects the marketplace, fetches via the adapter, and upserts', async function() {
        adapters.detectMarketplaceFromUrl.mockReturnValue('amazon');
        adapters.searchByLink.mockResolvedValue(fakeProviderProduct());

        const result = await productService.refreshProductByLink('https://www.amazon.in/dp/SVCTEST1');

        expect(result.product.externalId).toBe('SVCTEST1');
        expect(result.isNew).toBe(true);
    });

    it('throws a 400 when the URL matches no supported marketplace', async function() {
        adapters.detectMarketplaceFromUrl.mockReturnValue(null);

        await expect(productService.refreshProductByLink('https://www.ebay.com/itm/123')).rejects.toMatchObject({
            statusCode: 400,
        });

        expect(adapters.searchByLink).not.toHaveBeenCalled(); // should short-circuit before even trying
    });

    it('throws a 502 when the adapter cannot extract product details', async function() {
        adapters.detectMarketplaceFromUrl.mockReturnValue('amazon');
        adapters.searchByLink.mockResolvedValue(null);

        await expect(productService.refreshProductByLink('https://www.amazon.in/dp/DELISTED')).rejects.toMatchObject({
            statusCode: 502,
        });
    });
});