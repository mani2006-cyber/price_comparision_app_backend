// src/adapters/lenskart/lenskart.scraper.js
//
// Scraper-only Lenskart adapter - no official API exists, so this is
// the sole implementation (lenskart/index.js just re-exports it).
// Lenskart is a Next.js app that embeds full page data as JSON in a
// script tag - extractPageData() finds it via a size+content heuristic
// rather than a fragile selector, which survives markup/build changes.

'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const logger = require('../../utils/logger');
const config = require('../../config/env');
const { withDefaults, validateProviderProduct, validateProviderProductList } = require('../provider.interface');

const BASE = 'https://www.lenskart.com';
const MAX_SEARCH_RESULTS = config.scraper.maxSearchResults;

// Lenskart has no free-text search - it's category-browsing based.
// Maps common query terms to real category pages; anything unmatched
// falls back to a ?q= filter on the general eyeglasses category.
const CATEGORY_MAP = {
    'eyeglasses': '/eyeglasses.html',
    'sunglasses': '/sunglasses.html',
    'contact lenses': '/contact-lenses.html',
    'contact-lenses': '/contact-lenses.html',
    'computer glasses': '/computer-glasses.html',
    'kids glasses': '/kids-eyeglasses.html',
    'sports glasses': '/sports-eyeglasses.html',
};


// Lenskart's site does NOT actually filter its category pages by a
// free-text ?q= param - a query outside CATEGORY_MAP silently returns
// the same generic default listing regardless of what was searched.
// Rather than return misleading static results for "laptop" or
// "books", detect when a query is plausibly eyewear-related at all;
// if not, return [] honestly instead of hitting the site.
const EYEWEAR_KEYWORDS = [
    'glass', 'glasses', 'eyeglass', 'eyeglasses', 'sunglass', 'sunglasses',
    'spectacle', 'spectacles', 'frame', 'frames', 'lens', 'lenses',
    'eyewear', 'goggles', 'specs',
];

function isPlausiblyEyewearQuery(query) {
    const lower = query.toLowerCase();
    if (CATEGORY_MAP[lower]) return true;
    return EYEWEAR_KEYWORDS.some(function(kw) { return lower.indexOf(kw) !== -1; });
}


function getHeaders(referer) {
    return {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/124.0.6367.207 Safari/537.36',
        'Accept-Language': 'en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': referer || BASE,
    };
}

async function fetchHtml(url, referer) {
    const response = await axios.get(url, {
        headers: getHeaders(referer),
        timeout: config.scraper.timeoutMs,
        decompress: true,
        maxRedirects: 5,
    });
    return response.data;
}

// ── Helpers ──────────────────────────────────────────────────────────

function toNum(val) {
    if (val === null || val === undefined) return null;
    const n = parseFloat(String(val).replace(/[^0-9.]/g, ''));
    return Number.isNaN(n) ? null : n;
}

function cleanText(str) {
    return (str || '').replace(/\s+/g, ' ').trim() || null;
}

function buildKeywords(title) {
    if (!title) return [];
    return title
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(function(word) { return word.length > 1; })
        .slice(0, 20);
}

// Finds the Next.js data blob: the largest <script> tag over 50KB that
// contains "pageProps". This heuristic survives markup/build changes
// far better than targeting a specific script id or position.
function extractPageData(html) {
    const $ = cheerio.load(html);
    const scripts = $('script').map(function(_, el) { return $(el).html() || ''; }).get();

    const bigScript = scripts
        .filter(function(s) { return s.length > 50000 && s.indexOf('pageProps') !== -1; })
        .sort(function(a, b) { return b.length - a.length; })[0];

    if (!bigScript) return null;

    try {
        const parsed = JSON.parse(bigScript);
        return (parsed.props && parsed.props.pageProps && parsed.props.pageProps.data) || null;
    } catch (err) {
        return null;
    }
}

// prices = [{name:"Market Price", price:3000}, {name:"Sales Price", price:2500}]
function extractPrices(pricesArr) {
    if (!Array.isArray(pricesArr) || pricesArr.length === 0) {
        return { current: null, original: null };
    }

    let current = null;
    let original = null;

    pricesArr.forEach(function(p) {
        const name = (p.name || '').toLowerCase();
        const price = toNum(p.price);
        if (name.indexOf('sales') !== -1) current = price;
        else if (name.indexOf('market') !== -1) original = price;
    });

    if (current === null && pricesArr[0]) {
        current = toNum(pricesArr[0].price);
    }

    return { current, original };
}

// ── Mapping: a Lenskart product data node -> ProviderProduct ──────────

function buildProviderProduct(d) {
    if (!d || !d.brandName || !d.id) return null;

    const prices = extractPrices(d.prices);
    if (prices.current === null) return null;

    const gallery = [];
    if (d.imageUrl) gallery.push(d.imageUrl);
    if (Array.isArray(d.imageUrls)) {
        d.imageUrls.forEach(function(img) {
            if (img && gallery.indexOf(img) === -1) gallery.push(img);
        });
    }

    const review = d.review || {};

    const attributes = {};
    if (d.frameSize) attributes['Frame Size'] = d.frameSize;
    if (d.frameColor) attributes['Frame Color'] = d.frameColor;
    if (d.fit) attributes['Fit'] = d.fit;
    if (d.frameTypeKey) attributes['Frame Type'] = d.frameTypeKey;

    const title = cleanText([d.brandName, d.modelName, d.title].filter(Boolean).join(' '));
    if (!title) return null;

    const rawUrl = d.url ? (d.url.startsWith('http') ? d.url : BASE + d.url) : null;
    if (!rawUrl) return null;

    return withDefaults({
        marketplace: 'lenskart',
        externalId: String(d.id),
        title,
        brand: cleanText(d.brandName),
        category: cleanText(d.classification) || 'Eyewear',
        images: gallery.slice(0, config.product.maxImages),
        currentPrice: prices.current,
        originalPrice: prices.original,
        currency: 'INR',
        rating: {
            average: toNum(review.rating),
            reviews: toNum(review.ratingCount || review.reviewCount),
        },
        availability: d.qty !== null && d.qty !== undefined ? (d.qty > 0 ? 'in_stock' : 'out_of_stock') : 'unknown',
        delivery: { estimate: null, free: true }, // Lenskart offers free delivery site-wide
        rawUrl,
        keywords: buildKeywords(title),
        attributes,
        fetchedVia: 'scraper',
    });
}

// ── Search page parsing ─────────────────────────────────────────────

function parseSearchResults(html) {
    const pageData = extractPageData(html);
    if (!pageData || !Array.isArray(pageData.productListData)) return [];

    const results = [];
    const seen = {};

    for (let i = 0; i < pageData.productListData.length && results.length < MAX_SEARCH_RESULTS; i++) {
        const widget = pageData.productListData[i];
        const d = widget.data;
        if (!d || !d.brandName) continue;

        const pid = String(d.id || '');
        if (!pid || seen[pid]) continue;
        seen[pid] = true;

        const mapped = buildProviderProduct(d);
        if (mapped) results.push(mapped);
    }

    return results;
}

// ── Product page parsing ─────────────────────────────────────────────

function parseProductPage(html, url) {
    const pageData = extractPageData(html);
    if (!pageData || !pageData.productDetailData || !pageData.productDetailData.result) return null;

    const result = pageData.productDetailData.result;
    let galleryWidget = null;

    Object.keys(result).forEach(function(key) {
        const item = result[key];
        if (item && item.data && item.data.brandName && !galleryWidget) {
            galleryWidget = item.data;
        }
    });

    if (!galleryWidget) return null;
    if (!galleryWidget.url) galleryWidget.url = url;

    return buildProviderProduct(galleryWidget);
}

// ── Public contract ─────────────────────────────────────────────────

async function searchByQuery(query) {

    if (!isPlausiblyEyewearQuery(query)) {
        logger.debug('Lenskart scraper: query not eyewear-related, skipping', { query });
        return [];
    }

    const slug = query.toLowerCase().trim();
    const path = CATEGORY_MAP[slug] || ('/eyeglasses.html?q=' + encodeURIComponent(query));
    const url = BASE + path;

    let html;
    try {
        html = await fetchHtml(url, BASE);
    } catch (err) {
        logger.error('Lenskart scraper: search request failed', { query, message: err.message });
        throw err;
    }

    const results = parseSearchResults(html);
    logger.info('Lenskart scraper search finished', { query, count: results.length });

    return validateProviderProductList(results);
}

async function searchByLink(url) {
    let html;
    try {
        html = await fetchHtml(url, BASE + '/');
    } catch (err) {
        logger.error('Lenskart scraper: product page request failed', { url, message: err.message });
        throw err;
    }

    const result = parseProductPage(html, url);
    if (!result) {
        logger.warn('Lenskart scraper: could not extract product details', { url });
        return null;
    }

    logger.info('Lenskart scraper product-detail finished', { url });

    return validateProviderProduct(result);
}

module.exports = { searchByQuery, searchByLink };