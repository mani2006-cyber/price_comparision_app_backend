// tests/integration/services/compare.service.test.js
//
// Tests compare.service.js with adapters mocked. This is where the
// THREE live-debugging fixes get locked in at the SERVICE level (not
// just similarity.js in isolation): same-marketplace exclusion, the
// hard price gate (no accessory matching a phone), and the title-
// similarity gate (no unrelated product matching on generic words).

'use strict';

jest.mock('../../../src/adapters');
jest.mock('../../../src/services/aiComparison.service');

const mongoose = require('mongoose');
const config = require('../../../src/config/env');
const Product = require('../../../src/models/Product.model');
const adapters = require('../../../src/adapters');
const aiComparisonService = require('../../../src/services/aiComparison.service');
const compareService = require('../../../src/services/compare.service');

function fakeProduct(overrides) {
    return Object.assign({
            marketplace: 'amazon',
            externalId: 'CMPTEST_ORIG',
            title: 'Apple iPhone 16e 128 GB Black',
            currentPrice: 59900,
            rawUrl: 'https://www.amazon.in/dp/CMPTEST_ORIG',
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
    await Product.deleteMany({ externalId: { $regex: /^CMPTEST/ } });
});

describe('compareByUrl', function() {
    it('rejects a URL from an unsupported marketplace with a 400', async function() {
        adapters.detectMarketplaceFromUrl.mockReturnValue(null);
        adapters.getActiveMarketplaces.mockReturnValue(['amazon', 'flipkart', 'myntra', 'lenskart']);

        let caught;
        try {
            await compareService.compareByUrl('https://www.ebay.com/itm/123');
        } catch (err) {
            caught = err;
        }

        expect(caught.statusCode).toBe(400);
        expect(caught.message).toContain('amazon');
    });

    it('still returns a clean 400 even if getActiveMarketplaces itself fails unexpectedly', async function() {
        adapters.detectMarketplaceFromUrl.mockReturnValue(null);
        adapters.getActiveMarketplaces.mockImplementation(function() {
            throw new Error('unexpected failure building the marketplace list');
        });

        await expect(compareService.compareByUrl('https://www.ebay.com/itm/123')).rejects.toMatchObject({
            statusCode: 400,
        });
    });

    it('finds a genuine cross-marketplace match', async function() {
        adapters.detectMarketplaceFromUrl.mockReturnValue('amazon');
        adapters.searchByLink.mockResolvedValue(fakeProduct());
        adapters.searchAllMarketplaces.mockResolvedValue({
            results: [
                fakeProduct(), // the original itself, will come back in the search too
                fakeProduct({ marketplace: 'flipkart', externalId: 'CMPTEST_MATCH', title: 'Apple iPhone 16 128 GB Black', currentPrice: 67900 }),
            ],
            failures: [],
        });

        const result = await compareService.compareByUrl('https://www.amazon.in/dp/CMPTEST_ORIG');

        expect(result.matchesFound).toBe(1);
        expect(result.results.find(function(r) { return r.isOriginal; })).toBeDefined();
        const match = result.results.find(function(r) { return !r.isOriginal; });
        expect(match.marketplace).toBe('flipkart');
    });

    it('EXCLUDES same-marketplace results, even with high title similarity (regression: iPhone 17e matching iPhone 16e)', async function() {
        adapters.detectMarketplaceFromUrl.mockReturnValue('amazon');
        adapters.searchByLink.mockResolvedValue(fakeProduct());
        adapters.searchAllMarketplaces.mockResolvedValue({
            results: [
                fakeProduct(),
                // Same marketplace as the original, very similar title - this
                // used to incorrectly appear as a "match" before the fix.
                fakeProduct({ externalId: 'CMPTEST_SIBLING', title: 'Apple iPhone 17e 256 GB Black', currentPrice: 82490 }),
            ],
            failures: [],
        });

        const result = await compareService.compareByUrl('https://www.amazon.in/dp/CMPTEST_ORIG');

        expect(result.matchesFound).toBe(0);
        expect(result.results.every(function(r) { return r.marketplace !== 'amazon' || r.isOriginal; })).toBe(true);
    });

    it('EXCLUDES a cheap accessory sharing generic title words (regression: camera lens protector matching a phone)', async function() {
        adapters.detectMarketplaceFromUrl.mockReturnValue('amazon');
        adapters.searchByLink.mockResolvedValue(fakeProduct());
        adapters.searchAllMarketplaces.mockResolvedValue({
            results: [
                fakeProduct(),
                fakeProduct({
                    marketplace: 'flipkart',
                    externalId: 'CMPTEST_ACCESSORY',
                    title: 'Apple iPhone Camera Lens Protector',
                    currentPrice: 122,
                }),
            ],
            failures: [],
        });

        const result = await compareService.compareByUrl('https://www.amazon.in/dp/CMPTEST_ORIG');
        expect(result.matchesFound).toBe(0);
    });

    it('EXCLUDES an unrelated product sharing one generic word (regression: Fujifilm camera matching a phone)', async function() {
        adapters.detectMarketplaceFromUrl.mockReturnValue('amazon');
        adapters.searchByLink.mockResolvedValue(fakeProduct());
        adapters.searchAllMarketplaces.mockResolvedValue({
            results: [
                fakeProduct(),
                fakeProduct({
                    marketplace: 'myntra',
                    externalId: 'CMPTEST_UNRELATED',
                    title: 'FUJIFILM Instax Mini Instant Camera',
                    currentPrice: 37498,
                }),
            ],
            failures: [],
        });

        const result = await compareService.compareByUrl('https://www.amazon.in/dp/CMPTEST_ORIG');
        expect(result.matchesFound).toBe(0);
    });

    it('keeps only the single best match per marketplace, not every variant', async function() {
        adapters.detectMarketplaceFromUrl.mockReturnValue('amazon');
        adapters.searchByLink.mockResolvedValue(fakeProduct());
        adapters.searchAllMarketplaces.mockResolvedValue({
            results: [
                fakeProduct(),
                fakeProduct({ marketplace: 'flipkart', externalId: 'CMPTEST_V1', title: 'Apple iPhone 16 128 GB Black', currentPrice: 67900 }),
                fakeProduct({ marketplace: 'flipkart', externalId: 'CMPTEST_V2', title: 'Apple iPhone 16 128 GB Blue', currentPrice: 67900 }),
                fakeProduct({ marketplace: 'flipkart', externalId: 'CMPTEST_V3', title: 'Apple iPhone 16 128 GB Pink', currentPrice: 67900 }),
            ],
            failures: [],
        });

        const result = await compareService.compareByUrl('https://www.amazon.in/dp/CMPTEST_ORIG');

        const flipkartMatches = result.results.filter(function(r) { return r.marketplace === 'flipkart'; });
        expect(flipkartMatches).toHaveLength(1); // not 3
    });

    describe('aiSummary', function() {
        it('surfaces the AI service\'s summary on the result, called with the original + the actual good matches', async function() {
            adapters.detectMarketplaceFromUrl.mockReturnValue('amazon');
            adapters.searchByLink.mockResolvedValue(fakeProduct());
            adapters.searchAllMarketplaces.mockResolvedValue({
                results: [
                    fakeProduct(),
                    fakeProduct({ marketplace: 'flipkart', externalId: 'CMPTEST_MATCH', title: 'Apple iPhone 16 128 GB Black', currentPrice: 67900 }),
                ],
                failures: [],
            });
            aiComparisonService.generateComparisonSummary.mockResolvedValue('Amazon is the better deal here.');

            const result = await compareService.compareByUrl('https://www.amazon.in/dp/CMPTEST_ORIG');

            expect(result.aiSummary).toBe('Amazon is the better deal here.');
            expect(aiComparisonService.generateComparisonSummary).toHaveBeenCalledTimes(1);
            const [passedOriginal, passedMatches] = aiComparisonService.generateComparisonSummary.mock.calls[0];
            expect(passedOriginal.externalId).toBe('CMPTEST_ORIG');
            expect(passedMatches).toHaveLength(1);
            expect(passedMatches[0].marketplace).toBe('flipkart');
        });

        it('leaves aiSummary null without failing the whole request when the AI service reports nothing', async function() {
            adapters.detectMarketplaceFromUrl.mockReturnValue('amazon');
            adapters.searchByLink.mockResolvedValue(fakeProduct());
            adapters.searchAllMarketplaces.mockResolvedValue({
                results: [
                    fakeProduct(),
                    fakeProduct({ marketplace: 'flipkart', externalId: 'CMPTEST_MATCH', title: 'Apple iPhone 16 128 GB Black', currentPrice: 67900 }),
                ],
                failures: [],
            });
            aiComparisonService.generateComparisonSummary.mockResolvedValue(null);

            const result = await compareService.compareByUrl('https://www.amazon.in/dp/CMPTEST_ORIG');

            expect(result.aiSummary).toBeNull();
            expect(result.matchesFound).toBe(1); // the rest of the response is unaffected
        });
    });
});