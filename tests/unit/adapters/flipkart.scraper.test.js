// tests/unit/adapters/flipkart.scraper.test.js
//
// Unit tests for the Flipkart scraper - axios is mocked (no real
// network calls). Focused on searchByLink's image extraction
// specifically: parseProductDetail never extracted images at all
// before this fix, which meant upsertFromProviderData's unconditional
// `images: providerData.images` overwrite silently WIPED a product's
// previously-good images (from an earlier search) back to [] every
// time it got refreshed - found live, confirmed against the real
// database (10 real products already affected). See flipkart.scraper.js's
// own comment on extractGalleryImages for the full story.

'use strict';

jest.mock('axios');

const axios = require('axios');
const flipkart = require('../../../src/adapters/flipkart/flipkart.scraper');

// A minimal but structurally real fixture: a clean "₹<digits>" price
// node with no nested text (matching parseProductDetail's own
// document-order price-scan logic), plus a handful of <img> tags at
// the real width tiers this site actually uses.
function productPageHtml(imgTags) {
    return (
        '<html><body>' +
        '<h1>Apple iPhone 16 (Black, 128 GB)</h1>' +
        '<div><span>₹68900</span></div>' +
        (imgTags || '') +
        '</body></html>'
    );
}

const GALLERY_800 = [
    '<img src="https://rukminim2.flixcart.com/image/800/1070/xif0q/mobile/n/q/h/-original-imahgfmzjj8gtqbc.jpeg?q=90" />',
    '<img src="https://rukminim2.flixcart.com/image/800/1070/xif0q/mobile/x/k/m/-original-imahfvx37fmsbhhr.jpeg?q=90" />',
].join('');

// Same two photos, re-served as small thumbnails (SAME filename hash,
// different /W/H/ prefix) - must be deduped away, not counted as
// additional images.
const THUMBS_80 = [
    '<img src="https://rukminim2.flixcart.com/image/80/110/xif0q/mobile/n/q/h/-original-imahgfmzjj8gtqbc.jpeg?q=90" />',
    '<img src="https://rukminim2.flixcart.com/image/80/110/xif0q/mobile/x/k/m/-original-imahfvx37fmsbhhr.jpeg?q=90" />',
].join('');

const BRAND_BADGE = '<img src="https://rukminim2.flixcart.com/image/800/800/prod-fk-cms-brand-images/badge.jpg?q=90" />';
const PROMO_BANNER = '<img src="https://rukminim2.flixcart.com/www/300/90/promos/banner.png?q=90" />';
const UNRELATED_ICON = '<img src="https://static-assets-web.flixcart.com/batman-returns/images/fk-mp-c815b6.svg" />';

beforeEach(function() {
    jest.clearAllMocks();
});

describe('searchByLink - image extraction', function() {
    it('extracts the high-res (width>=700) gallery images', async function() {
        axios.get.mockResolvedValue({ data: productPageHtml(GALLERY_800) });

        const result = await flipkart.searchByLink('https://www.flipkart.com/x/p/y?pid=MOBH4DQFG8NKFRDY');

        expect(result.images).toEqual([
            'https://rukminim2.flixcart.com/image/800/1070/xif0q/mobile/n/q/h/-original-imahgfmzjj8gtqbc.jpeg?q=90',
            'https://rukminim2.flixcart.com/image/800/1070/xif0q/mobile/x/k/m/-original-imahfvx37fmsbhhr.jpeg?q=90',
        ]);
    });

    it('regression: no longer returns an empty images array for a real product page (the actual bug found live)', async function() {
        axios.get.mockResolvedValue({ data: productPageHtml(GALLERY_800) });

        const result = await flipkart.searchByLink('https://www.flipkart.com/x/p/y?pid=MOBH4DQFG8NKFRDY');

        expect(result.images.length).toBeGreaterThan(0);
    });

    it('dedupes a thumbnail (width=80) that is just a smaller re-serve of an already-collected high-res photo', async function() {
        axios.get.mockResolvedValue({ data: productPageHtml(GALLERY_800 + THUMBS_80) });

        const result = await flipkart.searchByLink('https://www.flipkart.com/x/p/y?pid=MOBH4DQFG8NKFRDY');

        expect(result.images).toHaveLength(2); // not 4 - the thumbnails are the SAME two photos
    });

    it('excludes seller/brand badge images and promo banners, even at large widths', async function() {
        axios.get.mockResolvedValue({ data: productPageHtml(GALLERY_800 + BRAND_BADGE + PROMO_BANNER + UNRELATED_ICON) });

        const result = await flipkart.searchByLink('https://www.flipkart.com/x/p/y?pid=MOBH4DQFG8NKFRDY');

        expect(result.images.every(function(url) { return url.indexOf('cms-brand-images') === -1; })).toBe(true);
        expect(result.images.every(function(url) { return url.indexOf('/promos/') === -1; })).toBe(true);
        expect(result.images.every(function(url) { return url.indexOf('static-assets-web') === -1; })).toBe(true);
    });

    it('falls back to a lower width tier (>=200) only when the page has no width>=700 images at all', async function() {
        const lowResOnly = '<img src="https://rukminim2.flixcart.com/image/312/312/xif0q/mobile/a/b/c/-original-imalowres1.jpeg?q=90" />';
        axios.get.mockResolvedValue({ data: productPageHtml(lowResOnly) });

        const result = await flipkart.searchByLink('https://www.flipkart.com/x/p/y?pid=MOBH4DQFG8NKFRDY');

        expect(result.images).toEqual(['https://rukminim2.flixcart.com/image/312/312/xif0q/mobile/a/b/c/-original-imalowres1.jpeg?q=90']);
    });

    it('caps the gallery at 10 images', async function() {
        let manyImages = '';
        for (let i = 0; i < 15; i++) {
            manyImages += '<img src="https://rukminim2.flixcart.com/image/800/1070/xif0q/mobile/n/q/' + i + '/-original-imaunique' + i + '.jpeg?q=90" />';
        }
        axios.get.mockResolvedValue({ data: productPageHtml(manyImages) });

        const result = await flipkart.searchByLink('https://www.flipkart.com/x/p/y?pid=MOBH4DQFG8NKFRDY');

        expect(result.images).toHaveLength(10);
    });

    it('returns an empty array (not null/undefined) when the page has no product images at all', async function() {
        axios.get.mockResolvedValue({ data: productPageHtml('') });

        const result = await flipkart.searchByLink('https://www.flipkart.com/x/p/y?pid=MOBH4DQFG8NKFRDY');

        expect(result.images).toEqual([]);
    });
});

describe('searchByLink - pid extraction (duplicate-product bug)', function() {
    // Real bug found live: extractPidFromUrl used to fall back to the /p/
    // PATH segment ("itm...") when a URL had no ?pid= query param, and
    // treated that as the pid - but it's a DIFFERENT identifier from the
    // real pid, embedded in the page's own JSON. Two live products ended
    // up duplicated in the DB because of it. See flipkart.scraper.js's
    // extractPidFromUrl/extractPidFromHtml comments for the full story.
    const PID_JSON = '<script>window.__X = {"pid":"ACCG6DS7WDJHGWSH","other":1};</script>';

    it('extracts the real pid from the page\'s own embedded JSON when the URL has no ?pid=', async function() {
        axios.get.mockResolvedValue({ data: productPageHtml(GALLERY_800 + PID_JSON) });

        // No ?pid= in this URL at all - matches the real-world case that
        // caused the duplicate-product bug.
        const result = await flipkart.searchByLink('https://www.flipkart.com/some-product/p/itmee33cb4f8c0b2');

        expect(result.externalId).toBe('ACCG6DS7WDJHGWSH');
    });

    it('never derives the pid from the URL\'s /p/<id> path segment (that segment is an item id, not a pid)', async function() {
        // No "pid" JSON in the page, and no ?pid= in the URL - the old
        // buggy fallback would have returned "ITMEE33CB4F8C0B2" here.
        axios.get.mockResolvedValue({ data: productPageHtml(GALLERY_800) });

        const result = await flipkart.searchByLink('https://www.flipkart.com/some-product/p/itmee33cb4f8c0b2');

        expect(result).toBeNull();
    });

    it('prefers the page\'s embedded pid over a ?pid= query param, when both are present but differ', async function() {
        axios.get.mockResolvedValue({ data: productPageHtml(GALLERY_800 + PID_JSON) });

        const result = await flipkart.searchByLink('https://www.flipkart.com/x/p/y?pid=SOMESTALEQUERYPID');

        expect(result.externalId).toBe('ACCG6DS7WDJHGWSH');
    });
});

describe('searchByLink - existing behavior, unaffected by the image fix', function() {
    it('still extracts title, price, and pid correctly', async function() {
        axios.get.mockResolvedValue({ data: productPageHtml(GALLERY_800) });

        const result = await flipkart.searchByLink('https://www.flipkart.com/apple-iphone-16-black-128-gb/p/itmb07d67f995271?pid=MOBH4DQFG8NKFRDY');

        expect(result.title).toBe('Apple iPhone 16 (Black, 128 GB)');
        expect(result.currentPrice).toBe(68900);
        expect(result.externalId).toBe('MOBH4DQFG8NKFRDY');
    });

    it('returns null when the page has no extractable price', async function() {
        axios.get.mockResolvedValue({ data: '<html><body><h1>Some Product</h1></body></html>' });

        const result = await flipkart.searchByLink('https://www.flipkart.com/x/p/y?pid=MOBH4DQFG8NKFRDY');

        expect(result).toBeNull();
    });
});
