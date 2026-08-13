// tests/unit/adapters/index.test.js
//
// Unit tests for adapters/index.js - the marketplace registry. Every
// individual marketplace module is auto-mocked (no real network calls);
// this file only tests the registry/aggregation logic itself: which
// marketplaces are considered "active", URL -> marketplace detection,
// and searchAllMarketplaces()'s Promise.allSettled fan-out behavior.
//
// Regression coverage: nykaa/poorvika/vijaysales were added to this
// registry in the same change that (separately) missed updating
// Product.model.js's own marketplace enum - see
// tests/integration/models/Product.test.js's "marketplace enum" block
// for that half of the story. This file pins that all three are
// actually reachable through the registry itself.

'use strict';

jest.mock('../../../src/adapters/amazon');
jest.mock('../../../src/adapters/flipkart');
jest.mock('../../../src/adapters/myntra');
jest.mock('../../../src/adapters/lenskart');
jest.mock('../../../src/adapters/nykaa');
jest.mock('../../../src/adapters/poorvika');
jest.mock('../../../src/adapters/vijaysales');

const amazon = require('../../../src/adapters/amazon');
const flipkart = require('../../../src/adapters/flipkart');
const myntra = require('../../../src/adapters/myntra');
const lenskart = require('../../../src/adapters/lenskart');
const nykaa = require('../../../src/adapters/nykaa');
const poorvika = require('../../../src/adapters/poorvika');
const vijaysales = require('../../../src/adapters/vijaysales');

const adapters = require('../../../src/adapters');

const ALL_MARKETPLACES = ['amazon', 'flipkart', 'myntra', 'lenskart', 'nykaa', 'poorvika', 'vijaysales'];

beforeEach(function() {
    jest.clearAllMocks();
});

describe('getActiveMarketplaces', function() {
    it('includes every registered marketplace, including nykaa/poorvika/vijaysales', function() {
        expect(adapters.getActiveMarketplaces().sort()).toEqual(ALL_MARKETPLACES.sort());
    });
});

describe('getAdapter', function() {
    it.each(['nykaa', 'poorvika', 'vijaysales'])('returns the %s adapter module', function(marketplace) {
        const adapter = adapters.getAdapter(marketplace);
        expect(typeof adapter.searchByQuery).toBe('function');
        expect(typeof adapter.searchByLink).toBe('function');
    });

    it('throws ApiError.badRequest for an unknown marketplace', function() {
        expect(function() { adapters.getAdapter('not-a-real-marketplace'); }).toThrow(/Unknown marketplace/);
    });
});

describe('detectMarketplaceFromUrl', function() {
    it.each([
        ['https://www.nykaa.com/some-product/p/123456', 'nykaa'],
        ['https://www.poorvika.com/apple-iphone-16/p', 'poorvika'],
        ['https://www.vijaysales.com/p/P1/1/apple-iphone-16', 'vijaysales'],
        ['https://www.amazon.in/dp/B0ABCDEFG', 'amazon'],
        ['https://www.ebay.com/itm/123', null],
    ])('resolves %s -> %s', function(url, expected) {
        expect(adapters.detectMarketplaceFromUrl(url)).toBe(expected);
    });

    it('returns null for an empty/falsy url', function() {
        expect(adapters.detectMarketplaceFromUrl('')).toBeNull();
        expect(adapters.detectMarketplaceFromUrl(null)).toBeNull();
    });
});

describe('searchAllMarketplaces', function() {
    function fakeProduct(marketplace) {
        return {
            marketplace,
            externalId: 'X1',
            title: 'Test product',
            currentPrice: 100,
            rawUrl: 'https://example.com/x1',
            fetchedVia: 'scraper',
        };
    }

    it('aggregates successful results from every marketplace', async function() {
        amazon.searchByQuery.mockResolvedValue([fakeProduct('amazon')]);
        flipkart.searchByQuery.mockResolvedValue([fakeProduct('flipkart')]);
        myntra.searchByQuery.mockResolvedValue([]);
        lenskart.searchByQuery.mockResolvedValue([]);
        nykaa.searchByQuery.mockResolvedValue([fakeProduct('nykaa')]);
        poorvika.searchByQuery.mockResolvedValue([fakeProduct('poorvika')]);
        vijaysales.searchByQuery.mockResolvedValue([fakeProduct('vijaysales')]);

        const { results, failures } = await adapters.searchAllMarketplaces('phone', {});

        expect(failures).toEqual([]);
        expect(results.map(function(r) { return r.marketplace; }).sort()).toEqual(
            ['amazon', 'flipkart', 'nykaa', 'poorvika', 'vijaysales'].sort()
        );
    });

    it('excludes a failing marketplace from results but reports it in failures - one bad marketplace does not drop the others', async function() {
        amazon.searchByQuery.mockResolvedValue([fakeProduct('amazon')]);
        flipkart.searchByQuery.mockResolvedValue([fakeProduct('flipkart')]);
        myntra.searchByQuery.mockResolvedValue([]);
        lenskart.searchByQuery.mockResolvedValue([]);
        nykaa.searchByQuery.mockRejectedValue(new Error('Nykaa 403'));
        poorvika.searchByQuery.mockResolvedValue([fakeProduct('poorvika')]);
        vijaysales.searchByQuery.mockResolvedValue([fakeProduct('vijaysales')]);

        const { results, failures } = await adapters.searchAllMarketplaces('phone', {});

        expect(results.map(function(r) { return r.marketplace; })).not.toContain('nykaa');
        expect(failures).toEqual([{ marketplace: 'nykaa', message: 'Nykaa 403' }]);
        // The other marketplaces' results still made it through.
        expect(results.map(function(r) { return r.marketplace; }).sort()).toEqual(
            ['amazon', 'flipkart', 'poorvika', 'vijaysales'].sort()
        );
    });
});

describe('searchByLink', function() {
    it('delegates to the detected marketplace adapter', async function() {
        const product = fakeProductForLink();
        vijaysales.searchByLink.mockResolvedValue(product);

        const url = 'https://www.vijaysales.com/p/P1/1/apple-iphone-16';
        const result = await adapters.searchByLink(url);

        expect(vijaysales.searchByLink).toHaveBeenCalledWith(url);
        expect(result).toBe(product);
    });

    it('throws ApiError.badRequest for an unsupported url', async function() {
        await expect(adapters.searchByLink('https://www.ebay.com/itm/123')).rejects.toThrow(
            /Could not detect a supported marketplace/
        );
    });

    function fakeProductForLink() {
        return {
            marketplace: 'vijaysales',
            externalId: '1',
            title: 'Apple iPhone 16',
            currentPrice: 68900,
            rawUrl: 'https://www.vijaysales.com/p/P1/1/apple-iphone-16',
            fetchedVia: 'scraper',
        };
    }
});
