// tests/unit/adapters/poorvika.scraper.test.js
//
// Unit tests for the Poorvika scraper - axios is mocked (no real
// network calls); HTML fixtures below reproduce the real page shapes
// this adapter was built and debugged against, including regression
// tests for two bugs found live and fixed during that session:
//   1. A rating badge glued directly onto a search-card's price text
//      with no separator (e.g. "₹ 1,199" + "5(1)") was making the price
//      parser report ₹1 instead of ₹1,199.
//   2. The nearest ancestor <div> of the title link does NOT contain
//      the card's <img> on this site's real markup - only a WIDER
//      ancestor does - so images came back empty until the card lookup
//      was changed to walk up until it finds one.

'use strict';

jest.mock('axios');

const axios = require('axios');
const poorvika = require('../../../src/adapters/poorvika/poorvika.scraper');

function jsonLdScript(obj) {
    return '<script type="application/ld+json">' + JSON.stringify(obj) + '</script>';
}

beforeEach(function() {
    jest.clearAllMocks();
});

describe('searchByQuery', function() {
    it('parses a normal card correctly (title, ungrouped 3-digit price, image)', async function() {
        const html = `
            <div class="outer-card">
              <div class="product-cardlist_card__IeCc4">
                <img src="https://img-prd-pim.poorvika.com/product/screen-protector.png" />
                <div class="product-cardlist_card__description__eduH5">
                  <a target="_blank" href="/universal-screen-protector-15-6-inch/p">
                    <b>Universal Screen Protector For 15.6 inch Laptop ( Transparent )</b>
                    <div class="product-cardlist_price__1aKwZ">
                      <span class="ml-1">₹ 799</span>
                    </div>
                  </a>
                </div>
              </div>
            </div>
        `;
        axios.get.mockResolvedValue({ data: html });

        const results = await poorvika.searchByQuery('laptop');

        expect(results).toHaveLength(1);
        expect(results[0].title).toBe('Universal Screen Protector For 15.6 inch Laptop ( Transparent )');
        expect(results[0].currentPrice).toBe(799);
        expect(results[0].images).toEqual(['https://img-prd-pim.poorvika.com/product/screen-protector.png']);
        expect(results[0].externalId).toBe('universal-screen-protector-15-6-inch');
        expect(results[0].marketplace).toBe('poorvika');
    });

    // Regression test for bug #1 - see file header.
    it('does not mistake a rating badge glued onto the price for extra digits', async function() {
        const html = `
            <div class="outer-card">
              <div class="product-cardlist_card__IeCc4">
                <img src="https://img-prd-pim.poorvika.com/product/zeb-ns2000.png" />
                <div class="product-cardlist_card__description__eduH5">
                  <a target="_blank" href="/zebronics-zeb-ns2000-laptop-stand-silver/p">
                    <b>Zebronics ZEB-NS2000 Laptop Stand ( Silver )</b>
                    <div class="product-cardlist_price__1aKwZ">
                      <span class="hidden"><b>Pre Book : </b></span>
                      <span class="ml-1 whitespace-nowrap">₹ 1,199</span><span class="rating-badge">5(1)</span>
                    </div>
                  </a>
                </div>
              </div>
            </div>
        `;
        axios.get.mockResolvedValue({ data: html });

        const results = await poorvika.searchByQuery('laptop stand');

        expect(results).toHaveLength(1);
        // Before the fix this came back as 1 (just the leading digit).
        expect(results[0].currentPrice).toBe(1199);
    });

    // Regression test for bug #1, lakh-range shape (the case the original
    // fixed-width regex WAS already handling correctly - kept as a
    // guard against a future "fix" re-narrowing the middle group back
    // to one-or-more).
    it('correctly parses a lakh-range price with a glued rating badge', async function() {
        const html = `
            <div class="outer-card">
              <div class="product-cardlist_card__IeCc4">
                <img src="https://img-prd-pim.poorvika.com/product/iphone.png" />
                <div class="product-cardlist_card__description__eduH5">
                  <a target="_blank" href="/apple-iphone-16-pro-max/p">
                    <b>Apple iPhone 16 Pro Max ( Desert Titanium,1TB )</b>
                    <div class="product-cardlist_price__1aKwZ">
                      <span class="ml-1 whitespace-nowrap">₹ 1,69,990</span><span class="rating-badge">5(1)</span>
                    </div>
                  </a>
                </div>
              </div>
            </div>
        `;
        axios.get.mockResolvedValue({ data: html });

        const results = await poorvika.searchByQuery('iphone 16');

        expect(results[0].currentPrice).toBe(169990);
    });

    // Regression test for bug #2 - see file header.
    it('finds the image on a wider ancestor, not just the immediate parent div', async function() {
        const html = `
            <div class="wide-card-wrapper">
              <img src="https://img-prd-pim.poorvika.com/product/gripp-bag.png" />
              <div class="immediate-parent-with-no-image">
                <a target="_blank" href="/gripp-bolt-sleeve-laptop-bag-red/p">
                  <b>Gripp Bolt Sleeve Laptop Bag For Apple Macbook 13.3/14 inch ( Red )</b>
                  <div class="product-cardlist_price__1aKwZ"><span>₹ 3,290</span></div>
                </a>
              </div>
            </div>
        `;
        axios.get.mockResolvedValue({ data: html });

        const results = await poorvika.searchByQuery('laptop bag');

        expect(results[0].images).toEqual(['https://img-prd-pim.poorvika.com/product/gripp-bag.png']);
        expect(results[0].currentPrice).toBe(3290);
    });

    it('skips a card with no parseable price rather than returning a wrong one', async function() {
        const html = `
            <div class="outer-card">
              <div class="product-cardlist_card__IeCc4">
                <img src="https://img-prd-pim.poorvika.com/product/x.png" />
                <a target="_blank" href="/no-price-item/p"><b>No Price Item</b></a>
              </div>
            </div>
        `;
        axios.get.mockResolvedValue({ data: html });

        const results = await poorvika.searchByQuery('laptop');
        expect(results).toHaveLength(0);
    });

    it('joins spaces with "+" in the PATH segment specifically (the %20 form 301-redirects on this site)', async function() {
        axios.get.mockResolvedValue({ data: '<html></html>' });

        await poorvika.searchByQuery('laptop stand');

        const calledUrl = axios.get.mock.calls[0][0];
        const pathSegment = calledUrl.split('?')[0];
        expect(pathSegment).toContain('/laptop+stand/s');
        expect(pathSegment).not.toContain('%20');
    });
});

describe('searchByLink', function() {
    function productPageHtml(overrides) {
        const product = Object.assign(
            {
                '@type': 'Product',
                name: 'Unlock the Apple iPhone 16 Black 128GB and Secure Best Price', // real site's SEO-copy top-level name
                sku: 'MYE73HN/A',
                image: ['https://img-prd-pim.poorvika.com/product/iphone-16-black.png'],
                description: 'The Apple iPhone 16 in Black with 128GB storage.',
                brand: { '@type': 'Brand', name: 'Apple' },
                offers: {
                    '@type': 'AggregateOffer',
                    lowPrice: 69900,
                    highPrice: 79900,
                    priceCurrency: 'INR',
                    offers: [
                        {
                            '@type': 'Offer',
                            price: 69900,
                            priceCurrency: 'INR',
                            itemOffered: { name: 'Apple iPhone 16 ( Black, 128GB )' },
                        },
                    ],
                },
            },
            overrides
        );

        const breadcrumb = {
            '@type': 'BreadcrumbList',
            itemListElement: [
                { item: { name: 'Home' } },
                { item: { name: 'Mobiles' } },
                { item: { name: 'Apple iPhone 16' } },
            ],
        };

        return '<html><head>' + jsonLdScript(product) + jsonLdScript(breadcrumb) + '</head><body></body></html>';
    }

    it('prefers offers.offers[0].itemOffered.name over the SEO-copy top-level name', async function() {
        axios.get.mockResolvedValue({ data: productPageHtml() });

        const result = await poorvika.searchByLink('https://www.poorvika.com/apple-iphone-16-black-128gb/p');

        expect(result.title).toBe('Apple iPhone 16 ( Black, 128GB )');
    });

    it('uses the concrete nested offer price, never AggregateOffer.lowPrice/highPrice directly', async function() {
        axios.get.mockResolvedValue({ data: productPageHtml() });

        const result = await poorvika.searchByLink('https://www.poorvika.com/apple-iphone-16-black-128gb/p');

        expect(result.currentPrice).toBe(69900);
        expect(result.originalPrice).toBe(79900); // highPrice IS used as MRP, just not as the selling price
    });

    it('does not report an MRP that is not actually greater than the selling price', async function() {
        const html = productPageHtml({
            offers: {
                '@type': 'AggregateOffer',
                lowPrice: 69900,
                highPrice: 69900, // same as the real price - not a genuine discount
                offers: [{ '@type': 'Offer', price: 69900, priceCurrency: 'INR', itemOffered: { name: 'X' } }],
            },
        });
        axios.get.mockResolvedValue({ data: html });

        const result = await poorvika.searchByLink('https://www.poorvika.com/apple-iphone-16-black-128gb/p');

        expect(result.originalPrice).toBeNull();
    });

    it('extracts brand and category (breadcrumb leaf) correctly', async function() {
        axios.get.mockResolvedValue({ data: productPageHtml() });

        const result = await poorvika.searchByLink('https://www.poorvika.com/apple-iphone-16-black-128gb/p');

        expect(result.brand).toBe('Apple');
        expect(result.category).toBe('Apple iPhone 16');
    });

    it('always reports availability as unknown - no reliable static signal exists on this site', async function() {
        axios.get.mockResolvedValue({ data: productPageHtml() });

        const result = await poorvika.searchByLink('https://www.poorvika.com/apple-iphone-16-black-128gb/p');

        expect(result.availability).toBe('unknown');
    });

    it('treats the literal string "undefined" as no description, not real text', async function() {
        const html = productPageHtml({ description: 'undefined' });
        axios.get.mockResolvedValue({ data: html });

        const result = await poorvika.searchByLink('https://www.poorvika.com/apple-iphone-16-black-128gb/p');

        expect(result.metadata.description).toBeNull();
    });

    it('returns null when the page has no usable JSON-LD Product block', async function() {
        axios.get.mockResolvedValue({ data: '<html><body>Not found</body></html>' });

        const result = await poorvika.searchByLink('https://www.poorvika.com/does-not-exist/p');
        expect(result).toBeNull();
    });

    it('returns null when the JSON-LD Product has no concrete nested offer price', async function() {
        const html = productPageHtml({
            offers: { '@type': 'AggregateOffer', lowPrice: 69900, highPrice: 79900, offers: [] },
        });
        axios.get.mockResolvedValue({ data: html });

        const result = await poorvika.searchByLink('https://www.poorvika.com/apple-iphone-16-black-128gb/p');
        expect(result).toBeNull();
    });
});
