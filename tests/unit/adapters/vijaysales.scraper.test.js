// tests/unit/adapters/vijaysales.scraper.test.js
//
// Unit tests for the Vijay Sales scraper - axios is mocked (no real
// network calls). Covers both real data paths this adapter uses:
//   - searchByQuery: two sequential GETs (discover Unbxd credentials
//     from a hidden <input>, then call Unbxd's own search API directly)
//   - searchByLink: JSON-LD "Product" block, with data-mrp/discount-label
//     regex fallbacks for fields JSON-LD doesn't carry

'use strict';

jest.mock('axios');

const axios = require('axios');
const vijaysales = require('../../../src/adapters/vijaysales/vijaysales.scraper');

function jsonLdScript(obj, singleQuoted) {
    const typeAttr = singleQuoted ? "type='application/ld+json'" : 'type="application/ld+json"';
    return '<script ' + typeAttr + '>' + JSON.stringify(obj) + '</script>';
}

function credentialsHtml(apiKey, siteKey) {
    return (
        '<html><body>' +
        '<input type="hidden" value="' + apiKey + '" id="unbxd-apiKey"/>' +
        '<input type="hidden" value="' + siteKey + '" id="unbxd-siteKey"/>' +
        '</body></html>'
    );
}

beforeEach(function() {
    jest.clearAllMocks();
});

describe('searchByQuery', function() {
    it('discovers Unbxd credentials, calls Unbxd directly, and maps results', async function() {
        axios.get
            .mockResolvedValueOnce({ data: credentialsHtml('KEY123', 'SITE456') })
            .mockResolvedValueOnce({
                data: {
                    response: {
                        products: [
                            {
                                sku: '232285',
                                title: 'Apple iPhone 16 (128GB Storage, Black)',
                                productUrl: 'https://www.vijaysales.com/p/P232288/232285/apple-iphone-16-128gb-storage-black',
                                thumbnailImage: 'https://vsprod.vijaysales.com/media/232285-image.jpg',
                                price: 68900,
                                mrp: 69900,
                            },
                        ],
                    },
                },
            });

        const results = await vijaysales.searchByQuery('iphone 16');

        expect(results).toHaveLength(1);
        expect(results[0].externalId).toBe('232285');
        expect(results[0].currentPrice).toBe(68900);
        expect(results[0].originalPrice).toBe(69900);
        expect(results[0].images).toEqual(['https://vsprod.vijaysales.com/media/232285-image.jpg']);

        // Second call must hit Unbxd directly with the discovered credentials.
        const unbxdUrl = axios.get.mock.calls[1][0];
        expect(unbxdUrl).toContain('https://search.unbxd.io/KEY123/SITE456/search');
        expect(unbxdUrl).toContain('q=iphone%2016');
    });

    it('does not report an mrp that is not actually greater than price', async function() {
        axios.get
            .mockResolvedValueOnce({ data: credentialsHtml('KEY123', 'SITE456') })
            .mockResolvedValueOnce({
                data: {
                    response: {
                        products: [
                            {
                                sku: 'X1',
                                title: 'Some product',
                                productUrl: 'https://www.vijaysales.com/p/x/X1/some-product',
                                price: 1000,
                                mrp: 1000, // same as price - not a real discount
                            },
                        ],
                    },
                },
            });

        const results = await vijaysales.searchByQuery('x');
        expect(results[0].originalPrice).toBeNull();
    });

    it('skips a result missing sku/title/productUrl/price rather than failing the whole batch', async function() {
        axios.get
            .mockResolvedValueOnce({ data: credentialsHtml('KEY123', 'SITE456') })
            .mockResolvedValueOnce({
                data: {
                    response: {
                        products: [
                            { sku: 'X1', title: 'Missing url and price' }, // dropped
                            {
                                sku: 'X2',
                                title: 'Valid product',
                                productUrl: 'https://www.vijaysales.com/p/x/X2/valid-product',
                                price: 500,
                            },
                        ],
                    },
                },
            });

        const results = await vijaysales.searchByQuery('x');
        expect(results).toHaveLength(1);
        expect(results[0].externalId).toBe('X2');
    });

    it('returns [] (not an error) when the credentials page has no Unbxd hidden inputs', async function() {
        axios.get.mockResolvedValueOnce({ data: '<html><body>no credentials here</body></html>' });

        const results = await vijaysales.searchByQuery('x');
        expect(results).toEqual([]);
        expect(axios.get).toHaveBeenCalledTimes(1); // never even tries the Unbxd call
    });
});

describe('searchByLink', function() {
    function productPageHtml(overrides, options) {
        const product = Object.assign(
            {
                '@type': 'Product',
                name: 'Apple iPhone 16 (128GB Storage, Black)',
                sku: '232285',
                mpn: 'MTP03HN/A',
                gtin: '195949822636',
                image: [
                    'https://vsprod.vijaysales.com/media/catalog/product/2/3/232285-image.jpg',
                    'https://vsprod.vijaysales.com/media/catalog/product/2/3/232285-image_1.jpg',
                ],
                description: 'Apple iPhone 16, 128GB, Black.',
                brand: { '@type': 'Brand', name: 'Apple' },
                offers: {
                    '@type': 'Offer',
                    price: '68900',
                    priceCurrency: 'INR',
                    availability: 'https://schema.org/InStock',
                },
            },
            overrides
        );

        const breadcrumb = {
            '@type': 'BreadcrumbList',
            itemListElement: [
                { name: 'Home' },
                { name: 'Mobiles' },
                { name: 'iPhones' },
                { name: 'Apple iPhone 16 (128GB Storage, Black)' }, // leaf = product's own name on this site
            ],
        };

        const priceBlockHtml = (options && options.priceBlockHtml) !== undefined
            ? options.priceBlockHtml
            : '<span data-format-amount="true" data-mrp="69900">₹69900</span>' +
              '<p class="product__price--discount-label">1% off</p>';

        return (
            '<html><head>' +
            jsonLdScript(product, options && options.singleQuoted) +
            jsonLdScript(breadcrumb, options && options.singleQuoted) +
            '</head><body>' + priceBlockHtml + '</body></html>'
        );
    }

    it('parses title/brand/images/sku from JSON-LD', async function() {
        axios.get.mockResolvedValue({ data: productPageHtml() });

        const result = await vijaysales.searchByLink('https://www.vijaysales.com/p/P232288/232285/apple-iphone-16-128gb-storage-black');

        expect(result.title).toBe('Apple iPhone 16 (128GB Storage, Black)');
        expect(result.brand).toBe('Apple');
        expect(result.externalId).toBe('232285');
        expect(result.images).toHaveLength(2);
        expect(result.currentPrice).toBe(68900);
    });

    it('parses the mid breadcrumb entry as category, excluding root AND the leaf (product name)', async function() {
        axios.get.mockResolvedValue({ data: productPageHtml() });

        const result = await vijaysales.searchByLink('https://www.vijaysales.com/p/P232288/232285/apple-iphone-16-128gb-storage-black');

        expect(result.category).toBe('iPhones');
    });

    it('falls back to the data-mrp attribute for originalPrice (JSON-LD has no MRP concept)', async function() {
        axios.get.mockResolvedValue({ data: productPageHtml() });

        const result = await vijaysales.searchByLink('https://www.vijaysales.com/p/P232288/232285/apple-iphone-16-128gb-storage-black');

        expect(result.originalPrice).toBe(69900);
        expect(result.discountPercentage).toBe(1);
    });

    it('does not report an mrp that is not actually greater than the selling price', async function() {
        const html = productPageHtml({}, {
            priceBlockHtml: '<span data-mrp="68900">₹68900</span>', // equal to price
        });
        axios.get.mockResolvedValue({ data: html });

        const result = await vijaysales.searchByLink('https://www.vijaysales.com/p/P232288/232285/apple-iphone-16-128gb-storage-black');
        expect(result.originalPrice).toBeNull();
    });

    it('maps the non-standard "OutofStock" casing correctly', async function() {
        const html = productPageHtml({
            offers: { '@type': 'Offer', price: '68900', priceCurrency: 'INR', availability: 'https://schema.org/OutofStock' },
        });
        axios.get.mockResolvedValue({ data: html });

        const result = await vijaysales.searchByLink('https://www.vijaysales.com/p/P232288/232285/apple-iphone-16-128gb-storage-black');
        expect(result.availability).toBe('out_of_stock');
    });

    it('parses single-quoted type=\'application/ld+json\' script tags too', async function() {
        const html = productPageHtml({}, { singleQuoted: true });
        axios.get.mockResolvedValue({ data: html });

        const result = await vijaysales.searchByLink('https://www.vijaysales.com/p/P232288/232285/apple-iphone-16-128gb-storage-black');
        expect(result).not.toBeNull();
        expect(result.title).toBe('Apple iPhone 16 (128GB Storage, Black)');
    });

    it('returns null when the page has no usable JSON-LD Product block', async function() {
        axios.get.mockResolvedValue({ data: '<html><body>Not found</body></html>' });

        const result = await vijaysales.searchByLink('https://www.vijaysales.com/p/does-not-exist/1');
        expect(result).toBeNull();
    });

    it('returns null when JSON-LD has no price', async function() {
        const html = productPageHtml({ offers: { '@type': 'Offer', priceCurrency: 'INR' } });
        axios.get.mockResolvedValue({ data: html });

        const result = await vijaysales.searchByLink('https://www.vijaysales.com/p/P232288/232285/apple-iphone-16-128gb-storage-black');
        expect(result).toBeNull();
    });
});
