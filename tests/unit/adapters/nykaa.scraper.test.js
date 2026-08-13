// tests/unit/adapters/nykaa.scraper.test.js
//
// Unit tests for the Nykaa scraper - axios is mocked (no real network
// calls). Covers both real data paths this adapter uses:
//   - searchByQuery: the search-suggestions endpoint carries no price,
//     so each candidate's product page is fetched in parallel to fill
//     it in (best-effort - a failing candidate is dropped, not fatal)
//   - searchByLink: JSON-LD "Product" block is primary, with
//     window.__PRELOADED_STATE__ as the only source for MRP/rating/
//     seller/variant, and a fallback for price/availability if JSON-LD
//     is ever missing them

'use strict';

jest.mock('axios');

const axios = require('axios');
const nykaa = require('../../../src/adapters/nykaa/nykaa.scraper');

function jsonLdScript(obj) {
    return '<script type="application/ld+json">' + JSON.stringify(obj) + '</script>';
}

function preloadedStateScript(product) {
    return '<script>window.__PRELOADED_STATE__ = ' + JSON.stringify({ productPage: { product } }) + ';</script>';
}

function productPageHtml(jsonLdOverrides, preloadedOverrides, options) {
    const jsonLd = Object.assign(
        {
            '@type': 'Product',
            name: 'Maybelline New York Superstay Matte Ink Liquid Lipstick',
            sku: '229917',
            image: ['https://images-static.nykaa.com/media/catalog/product/6a307f96902395682806_1.jpg'],
            description: 'Long-lasting matte liquid lipstick.',
            brand: 'Maybelline New York', // plain string on this site, not {name}
            offers: { '@type': 'Offer', price: 429, priceCurrency: 'INR', availability: 'https://schema.org/InStock' },
        },
        jsonLdOverrides
    );

    const breadcrumb = {
        '@type': 'BreadcrumbList',
        itemListElement: [{ name: 'Home' }, { name: 'Makeup' }, { name: 'Lips' }, { name: 'Liquid Lipstick' }],
    };

    const preloadedProduct = preloadedOverrides === null ? null : Object.assign(
        {
            id: '229917',
            mrp: 550,
            offerPrice: 429,
            discount: 22,
            inStock: true,
            sellerName: 'Nykaa E retail limited',
            rating: 4.5,
            ratingCount: 1200,
            variantType: 'shade',
            selectedVariantName: '15 Lover',
        },
        preloadedOverrides
    );

    const bodyParts = [];
    if (!(options && options.omitJsonLd)) {
        bodyParts.push(jsonLdScript(jsonLd));
        bodyParts.push(jsonLdScript(breadcrumb));
    }
    if (preloadedProduct !== null) {
        bodyParts.push(preloadedStateScript(preloadedProduct));
    }

    return '<html><head>' + bodyParts.join('') + '</head><body></body></html>';
}

beforeEach(function() {
    jest.clearAllMocks();
});

describe('searchByLink', function() {
    it('parses title/brand/price from JSON-LD and mrp/rating/seller/variant from __PRELOADED_STATE__', async function() {
        axios.get.mockResolvedValue({ data: productPageHtml() });

        const result = await nykaa.searchByLink('https://www.nykaa.com/maybelline-.../p/229917');

        expect(result.title).toBe('Maybelline New York Superstay Matte Ink Liquid Lipstick');
        expect(result.brand).toBe('Maybelline New York');
        expect(result.externalId).toBe('229917');
        expect(result.currentPrice).toBe(429);
        expect(result.originalPrice).toBe(550);
        expect(result.rating).toEqual({ average: 4.5, reviews: 1200 });
        expect(result.seller.name).toBe('Nykaa E retail limited');
        expect(result.attributes).toEqual({ shade: '15 Lover' });
        expect(result.availability).toBe('in_stock');
        expect(result.category).toBe('Liquid Lipstick');
    });

    it('accepts brand as a plain string (this site) as well as {name: ...} (schema.org\'s other allowed shape)', async function() {
        axios.get.mockResolvedValue({ data: productPageHtml({ brand: { '@type': 'Brand', name: 'Nested Brand' } }) });

        const result = await nykaa.searchByLink('https://www.nykaa.com/x/p/229917');
        expect(result.brand).toBe('Nested Brand');
    });

    it('falls back to __PRELOADED_STATE__.offerPrice when JSON-LD has no price', async function() {
        const html = productPageHtml({ offers: { '@type': 'Offer', priceCurrency: 'INR' } });
        axios.get.mockResolvedValue({ data: html });

        const result = await nykaa.searchByLink('https://www.nykaa.com/x/p/229917');
        expect(result.currentPrice).toBe(429); // from preloaded.offerPrice
    });

    it('falls back to __PRELOADED_STATE__.inStock when JSON-LD has no availability', async function() {
        const html = productPageHtml(
            { offers: { '@type': 'Offer', price: 429, priceCurrency: 'INR' } },
            { inStock: false }
        );
        axios.get.mockResolvedValue({ data: html });

        const result = await nykaa.searchByLink('https://www.nykaa.com/x/p/229917');
        expect(result.availability).toBe('out_of_stock');
    });

    it('has no variant axis when the product has none (empty selectedVariantName, no variantType)', async function() {
        const html = productPageHtml({}, { variantType: undefined, selectedVariantName: '' });
        axios.get.mockResolvedValue({ data: html });

        const result = await nykaa.searchByLink('https://www.nykaa.com/x/p/229917');
        expect(result.attributes).toEqual({});
    });

    it('still returns a valid product when __PRELOADED_STATE__ is entirely absent - JSON-LD alone is enough for the required fields', async function() {
        const html = productPageHtml({}, null);
        axios.get.mockResolvedValue({ data: html });

        const result = await nykaa.searchByLink('https://www.nykaa.com/x/p/229917');
        expect(result).not.toBeNull();
        expect(result.currentPrice).toBe(429);
        expect(result.originalPrice).toBeNull(); // MRP has no other source
        expect(result.rating).toEqual({ average: null, reviews: null });
    });

    it('returns null when there is no usable JSON-LD Product block at all', async function() {
        axios.get.mockResolvedValue({ data: productPageHtml({}, {}, { omitJsonLd: true }) });

        const result = await nykaa.searchByLink('https://www.nykaa.com/x/p/229917');
        expect(result).toBeNull();
    });

    it('returns null when neither JSON-LD nor preloaded state has a price', async function() {
        const html = productPageHtml({ offers: { '@type': 'Offer', priceCurrency: 'INR' } }, { offerPrice: undefined });
        axios.get.mockResolvedValue({ data: html });

        const result = await nykaa.searchByLink('https://www.nykaa.com/x/p/229917');
        expect(result).toBeNull();
    });
});

describe('searchByQuery', function() {
    function suggestionsResponse(products) {
        return {
            status: 'OK',
            suggestions: [
                // A non-product "query" suggestion mixed in, matching real
                // responses - must be filtered out, not treated as a result.
                { type: 'query', q: 'lipstick combo pack offer', url: '/search/result/?q=lipstick+combo+pack+offer' },
            ].concat(products),
        };
    }

    function productSuggestion(overrides) {
        return Object.assign(
            {
                type: 'product',
                q: 'Maybelline New York Superstay Matte Ink Liquid Lipstick',
                id: '229917',
                slug: 'maybelline-new-york-superstay-matte-ink-liquid-lipstick/p/229917',
                image_v2: 'https://images-static.nykaa.com/thumb.jpg',
            },
            overrides
        );
    }

    it('fetches each product-type suggestion\'s page in parallel and returns the successfully-parsed ones', async function() {
        axios.get.mockImplementation(function(url) {
            if (url.indexOf('/gludo/searchSuggestions') !== -1) {
                return Promise.resolve({ data: suggestionsResponse([productSuggestion()]) });
            }
            return Promise.resolve({ data: productPageHtml() });
        });

        const results = await nykaa.searchByQuery('lipstick');

        expect(results).toHaveLength(1);
        expect(results[0].externalId).toBe('229917');
        expect(results[0].currentPrice).toBe(429);
    });

    it('drops a "query"-type suggestion (a refined search string, not a real product)', async function() {
        axios.get.mockImplementation(function(url) {
            if (url.indexOf('/gludo/searchSuggestions') !== -1) {
                return Promise.resolve({ data: suggestionsResponse([]) }); // only the query-type entry from the helper
            }
            return Promise.resolve({ data: productPageHtml() });
        });

        const results = await nykaa.searchByQuery('lipstick');
        expect(results).toHaveLength(0);
        // Never even tried to fetch a product page for the query-type entry.
        expect(axios.get).toHaveBeenCalledTimes(1);
    });

    it('drops a candidate whose product-page fetch fails, without failing the whole search', async function() {
        axios.get.mockImplementation(function(url) {
            if (url.indexOf('/gludo/searchSuggestions') !== -1) {
                return Promise.resolve({
                    data: suggestionsResponse([
                        productSuggestion({ id: '1', slug: 'ok-product/p/1' }),
                        productSuggestion({ id: '2', slug: 'blocked-product/p/2' }),
                    ]),
                });
            }
            if (url.indexOf('/blocked-product/') !== -1) {
                return Promise.reject(Object.assign(new Error('Request failed with status code 403'), { response: { status: 403 } }));
            }
            return Promise.resolve({ data: productPageHtml({ sku: '1' }) });
        });

        const results = await nykaa.searchByQuery('lipstick');
        expect(results).toHaveLength(1);
        expect(results[0].externalId).toBe('1');
    });

    it('returns [] when the suggestions response has no product-type entries at all', async function() {
        axios.get.mockResolvedValue({ data: suggestionsResponse([]) });

        const results = await nykaa.searchByQuery('lipstick');
        expect(results).toEqual([]);
    });

    it('propagates an error from the suggestions request itself (not per-candidate - the whole search has nothing to work with)', async function() {
        axios.get.mockRejectedValue(new Error('network down'));

        await expect(nykaa.searchByQuery('lipstick')).rejects.toThrow('network down');
    });
});
