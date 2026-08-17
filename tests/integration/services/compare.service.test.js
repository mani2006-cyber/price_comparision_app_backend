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

    describe('similarProducts', function() {
        it('surfaces a same-marketplace variant here instead of discarding it - the iPhone 17e case, but as a suggestion not a price match', async function() {
            adapters.detectMarketplaceFromUrl.mockReturnValue('amazon');
            adapters.searchByLink.mockResolvedValue(fakeProduct());
            adapters.searchAllMarketplaces.mockResolvedValue({
                results: [
                    fakeProduct(),
                    fakeProduct({ externalId: 'CMPTEST_SIBLING', title: 'Apple iPhone 17e 256 GB Black', currentPrice: 82490 }),
                ],
                failures: [],
            });

            const result = await compareService.compareByUrl('https://www.amazon.in/dp/CMPTEST_ORIG');

            expect(result.matchesFound).toBe(0); // still not a price-comparison match
            expect(result.similarProducts).toHaveLength(1); // but not thrown away either
            expect(result.similarProducts[0].externalId).toBe('CMPTEST_SIBLING');
            expect(result.similarProducts[0].isOriginal).toBeUndefined(); // not tagged like results[] entries
        });

        it('does NOT duplicate a product that is already in results[] as a genuine match', async function() {
            adapters.detectMarketplaceFromUrl.mockReturnValue('amazon');
            adapters.searchByLink.mockResolvedValue(fakeProduct());
            adapters.searchAllMarketplaces.mockResolvedValue({
                results: [
                    fakeProduct(),
                    fakeProduct({ marketplace: 'flipkart', externalId: 'CMPTEST_MATCH', title: 'Apple iPhone 16 128 GB Black', currentPrice: 67900 }),
                ],
                failures: [],
            });

            const result = await compareService.compareByUrl('https://www.amazon.in/dp/CMPTEST_ORIG');

            expect(result.matchesFound).toBe(1);
            const matchIds = result.results.map(function(r) { return r.externalId; });
            const similarIds = result.similarProducts.map(function(r) { return r.externalId; });
            expect(similarIds.some(function(id) { return matchIds.indexOf(id) !== -1; })).toBe(false);
        });

        it('still excludes a genuinely unrelated product sharing only a generic word - not every leftover becomes "similar"', async function() {
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

            expect(result.similarProducts).toHaveLength(0);
        });

        it('respects config.compare.maxSimilarProducts as a cap on the underlying POOL (similarProductsTotal), not just the current page', async function() {
            adapters.detectMarketplaceFromUrl.mockReturnValue('amazon');
            adapters.searchByLink.mockResolvedValue(fakeProduct());
            const manyVariants = [];
            for (let i = 0; i < config.compare.maxSimilarProducts + 5; i++) {
                manyVariants.push(fakeProduct({ externalId: 'CMPTEST_VAR' + i, title: 'Apple iPhone 16e 128 GB Variant ' + i, currentPrice: 59900 + i }));
            }
            adapters.searchAllMarketplaces.mockResolvedValue({
                results: [fakeProduct()].concat(manyVariants),
                failures: [],
            });

            const result = await compareService.compareByUrl('https://www.amazon.in/dp/CMPTEST_ORIG');

            expect(result.similarProductsTotal).toBe(config.compare.maxSimilarProducts); // the pool itself is capped
            expect(result.similarProducts.length).toBeLessThanOrEqual(config.compare.similarProductsDefaultLimit); // this page is smaller still
        });

        it('is empty (not missing/undefined) when there is nothing similar to suggest', async function() {
            adapters.detectMarketplaceFromUrl.mockReturnValue('amazon');
            adapters.searchByLink.mockResolvedValue(fakeProduct());
            adapters.searchAllMarketplaces.mockResolvedValue({ results: [fakeProduct()], failures: [] });

            const result = await compareService.compareByUrl('https://www.amazon.in/dp/CMPTEST_ORIG');

            expect(result.similarProducts).toEqual([]);
            expect(result.similarProductsTotal).toBe(0);
            expect(result.similarProductsTotalPages).toBe(0);
        });
    });

    describe('similarProducts pagination', function() {
        function manyVariantResults() {
            const variants = [];
            for (let i = 0; i < 25; i++) {
                variants.push(fakeProduct({ externalId: 'CMPTEST_VAR' + i, title: 'Apple iPhone 16e 128 GB Variant ' + i, currentPrice: 59900 + i }));
            }
            return [fakeProduct()].concat(variants);
        }

        it('defaults to page 1 with config.compare.similarProductsDefaultLimit results', async function() {
            adapters.detectMarketplaceFromUrl.mockReturnValue('amazon');
            adapters.searchByLink.mockResolvedValue(fakeProduct());
            adapters.searchAllMarketplaces.mockResolvedValue({ results: manyVariantResults(), failures: [] });

            const result = await compareService.compareByUrl('https://www.amazon.in/dp/CMPTEST_ORIG');

            expect(result.similarProductsPage).toBe(1);
            expect(result.similarProductsLimit).toBe(config.compare.similarProductsDefaultLimit);
            expect(result.similarProducts).toHaveLength(config.compare.similarProductsDefaultLimit);
            expect(result.similarProductsTotal).toBe(25);
            expect(result.similarProductsTotalPages).toBe(Math.ceil(25 / config.compare.similarProductsDefaultLimit));
        });

        it('returns a disjoint slice for an explicit page/limit', async function() {
            adapters.detectMarketplaceFromUrl.mockReturnValue('amazon');
            adapters.searchByLink.mockResolvedValue(fakeProduct());
            adapters.searchAllMarketplaces.mockResolvedValue({ results: manyVariantResults(), failures: [] });

            const page1 = await compareService.compareByUrl('https://www.amazon.in/dp/CMPTEST_ORIG', { page: 1, limit: 10 });
            const page2 = await compareService.compareByUrl('https://www.amazon.in/dp/CMPTEST_ORIG', { page: 2, limit: 10 });

            expect(page1.similarProducts).toHaveLength(10);
            expect(page2.similarProducts).toHaveLength(10);
            const page1Ids = page1.similarProducts.map(function(p) { return p.externalId; });
            const page2Ids = page2.similarProducts.map(function(p) { return p.externalId; });
            expect(page1Ids).not.toEqual(expect.arrayContaining(page2Ids));
        });

        it('an out-of-range page returns an empty array, not an error', async function() {
            adapters.detectMarketplaceFromUrl.mockReturnValue('amazon');
            adapters.searchByLink.mockResolvedValue(fakeProduct());
            adapters.searchAllMarketplaces.mockResolvedValue({ results: manyVariantResults(), failures: [] });

            const result = await compareService.compareByUrl('https://www.amazon.in/dp/CMPTEST_ORIG', { page: 99, limit: 10 });

            expect(result.similarProducts).toEqual([]);
            expect(result.similarProductsTotal).toBe(25);
        });

        // The real point of moving caching down into the service (see
        // compare.service.js's own header comment): a cache HIT must still
        // paginate fresh per request, not replay whichever page was cached
        // first. Two DIFFERENT pages for the SAME url, with the underlying
        // expensive work (search) only actually running once.
        it('a cached URL still returns the correct page on a second call with DIFFERENT pagination', async function() {
            adapters.detectMarketplaceFromUrl.mockReturnValue('amazon');
            adapters.searchByLink.mockResolvedValue(fakeProduct());
            adapters.searchAllMarketplaces.mockResolvedValue({ results: manyVariantResults(), failures: [] });

            const page1 = await compareService.compareByUrl('https://www.amazon.in/dp/CMPTEST_ORIG', { page: 1, limit: 5 });
            const page3 = await compareService.compareByUrl('https://www.amazon.in/dp/CMPTEST_ORIG', { page: 3, limit: 5 });

            expect(page1.similarProductsPage).toBe(1);
            expect(page3.similarProductsPage).toBe(3);
            const page1Ids = page1.similarProducts.map(function(p) { return p.externalId; });
            const page3Ids = page3.similarProducts.map(function(p) { return p.externalId; });
            expect(page1Ids).not.toEqual(expect.arrayContaining(page3Ids));
        });
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