// src/adapters/myntra/myntra.scraper.js
//
// Scraper-only Myntra adapter - no official API exists for this
// marketplace, so this is the sole implementation (myntra/index.js just
// passes straight through to this file, no mode switching). Primary
// strategy: parse Myntra's embedded window.__myx page-state JSON, which
// is far more reliable than CSS selectors. Falls back to Cheerio
// selectors only if that state object is absent.

'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const logger = require('../../utils/logger');
const config = require('../../config/env');
const { withDefaults, validateProviderProduct, validateProviderProductList } = require('../provider.interface');

const BASE = 'https://www.myntra.com';
const MAX_SEARCH_RESULTS = config.scraper.maxSearchResults;

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

function toNum(str) {
    if (str === null || str === undefined) return null;
    const n = parseFloat(String(str).replace(/[^0-9.]/g, ''));
    return Number.isNaN(n) ? null : n;
}

function cleanText(str) {
    return (str || '').replace(/\s+/g, ' ').trim() || null;
}

function extractMyntraId(url) {
    if (!url) return null;
    const m = String(url).match(/\/(\d{5,})\b/);
    return m ? m[1] : null;
}

function cleanProductUrl(url) {
    if (!url) return null;
    try {
        const full = url.startsWith('http') ? url : BASE + url;
        const u = new URL(full);
        return u.origin + u.pathname;
    } catch (err) {
        return url;
    }
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

// Extracts window.__myx = {...} using brace-counting - a naive regex
// would break on nested braces inside the JSON itself.
function extractMyxState(html) {
    try {
        const marker = 'window.__myx =';
        const markerStart = html.indexOf(marker);
        if (markerStart === -1) return null;

        let i = html.indexOf('{', markerStart);
        if (i === -1) return null;

        let depth = 0;
        let end = i;
        for (; end < html.length; end++) {
            if (html[end] === '{') depth++;
            else if (html[end] === '}') {
                depth--;
                if (depth === 0) break;
            }
        }
        return JSON.parse(html.slice(i, end + 1));
    } catch (err) {
        return null;
    }
}

const FASHION_BRANDS = [
    'Nike', 'Adidas', 'Puma', 'Reebok', 'H&M', 'Zara', 'Mango', 'Arrow',
    'Van Heusen', 'Allen Solly', 'Raymond', 'Peter England', 'Louis Philippe',
    'Roadster', 'HRX', 'Campus Sutra', 'Bewakoof', 'The Souled Store',
    'boAt', 'Noise', 'Fastrack', 'Titan', 'Casio', 'Fossil', 'Crocs',
    'Bata', 'Woodland', 'Skechers', 'Metro',
];

function extractBrand(title) {
    for (let i = 0; i < FASHION_BRANDS.length; i++) {
        const b = FASHION_BRANDS[i];
        const pattern = new RegExp('\\b' + b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
        if (pattern.test(title)) return b;
    }
    return (title || '').split(' ')[0] || null;
}

// ── Search page parsing ─────────────────────────────────────────────

function parseSearchResultsFromState(state, query) {
    let rawProducts = null;
    try { rawProducts = state.searchData.results.products; } catch (err) { /* not present */ }
    if (!Array.isArray(rawProducts) || rawProducts.length === 0) {
        try { rawProducts = state.searchData.results.plaProducts; } catch (err) { /* not present */ }
    }
    if (!Array.isArray(rawProducts)) return null;

    const results = [];
    for (let i = 0; i < rawProducts.length && results.length < MAX_SEARCH_RESULTS; i++) {
        const p = rawProducts[i];
        const pid = String(p.productId || p.id || '');
        if (!pid) continue;

        const productName = cleanText(p.productName);
        const brand = cleanText(p.brand) || extractBrand(productName || '');
        const title = (brand && productName && !productName.toLowerCase().startsWith(brand.toLowerCase())) ?
            brand + ' ' + productName :
            (productName || brand);
        if (!title) continue;

        const currentPrice = toNum(p.price);
        if (currentPrice === null) continue;

        const rawHref = p.landingPageUrl ? ('/' + p.landingPageUrl.replace(/^\//, '')) : null;
        const rawUrl = rawHref ? (BASE + rawHref) : null;
        if (!rawUrl) continue;

        let inStock = false;
        if (Array.isArray(p.inventoryInfo)) {
            inStock = p.inventoryInfo.some(function(s) { return s.available === true || s.inventory > 0; });
        } else if (p.inventoryInfo) {
            inStock = true;
        }

        const sizeLabels = Array.isArray(p.inventoryInfo) ?
            p.inventoryInfo.filter(function(s) { return s.available; }).map(function(s) { return s.label || s.size; }).filter(Boolean) :
            [];

        results.push(
            withDefaults({
                marketplace: 'myntra',
                externalId: pid,
                title,
                brand,
                category: (p.articleType && p.articleType.typeName) || null,
                images: p.searchImage ? [p.searchImage] : [],
                currentPrice,
                originalPrice: toNum(p.mrp),
                currency: 'INR',
                rating: { average: toNum(p.rating), reviews: null },
                availability: inStock ? 'in_stock' : 'out_of_stock',
                rawUrl,
                keywords: buildKeywords(title),
                attributes: sizeLabels.length > 0 ? { 'Available Sizes': sizeLabels.join(', ') } : {},
                fetchedVia: 'scraper',
            })
        );
    }

    return results;
}

function parseSearchResultsFromCheerio(html) {
    const $ = cheerio.load(html);
    const results = [];

    $('li.product-base').each(function(_, el) {
        if (results.length >= MAX_SEARCH_RESULTS) return;

        const card = $(el);
        const rawHref = card.find('a').first().attr('href') || null;
        const pid = extractMyntraId(rawHref);
        if (!pid) return;

        const brand = cleanText(card.find('.product-brand').text());
        const productName = cleanText(card.find('.product-product').text());
        const title = [brand, productName].filter(Boolean).join(' ');
        if (!title) return;

        const currentPrice = toNum(card.find('.product-discountedPrice').text());
        if (currentPrice === null) return;

        const image = card.find('img.img-responsive, img.product-image').first().attr('src') || null;
        const rawUrl = cleanProductUrl(rawHref);
        if (!rawUrl) return;

        results.push(
            withDefaults({
                marketplace: 'myntra',
                externalId: pid,
                title,
                brand,
                images: image ? [image] : [],
                currentPrice,
                originalPrice: toNum(card.find('.product-strike').text()),
                currency: 'INR',
                rawUrl,
                keywords: buildKeywords(title),
                fetchedVia: 'scraper',
            })
        );
    });

    return results;
}

// ── Product page parsing ─────────────────────────────────────────────

function parseProductPageFromState(pdp, url) {
    const pid = String(pdp.id || pdp.productId || extractMyntraId(url) || '');
    if (!pid) return null;

    const title = cleanText(pdp.name || pdp.productName);
    if (!title) return null;

    const brand = cleanText((pdp.brand && typeof pdp.brand === 'object') ? pdp.brand.name : pdp.brand);

    let currentPrice = null;
    let originalPrice = null;
    if (pdp.price && typeof pdp.price === 'object') {
        currentPrice = toNum(pdp.price.discounted);
        originalPrice = toNum(pdp.price.mrp);
    }
    if (currentPrice === null && pdp.selectedSeller) {
        currentPrice = toNum(pdp.selectedSeller.discountedPrice);
    }
    if (currentPrice === null) return null;

    let rating = null;
    let reviews = null;
    if (pdp.ratings && typeof pdp.ratings === 'object') {
        rating = toNum(pdp.ratings.averageRating);
        reviews = toNum(pdp.ratings.totalCount);
    }

    const sizes = Array.isArray(pdp.sizes) ? pdp.sizes : [];
    const inStock = sizes.some(function(s) { return s.available === true; });
    const availableSizeLabels = sizes.filter(function(s) { return s.available; })
        .map(function(s) { return cleanText(s.label || s.size || s.skuSize); })
        .filter(Boolean);

    const gallery = [];
    if (pdp.media && Array.isArray(pdp.media.albums)) {
        pdp.media.albums.forEach(function(album) {
            if (Array.isArray(album.images)) {
                album.images.forEach(function(img) {
                    const src = img.imageURL || img.secureSrc || img.src;
                    if (src) gallery.push(src);
                });
            }
        });
    }

    const attributes = {};
    if (pdp.articleAttributes && typeof pdp.articleAttributes === 'object') {
        Object.keys(pdp.articleAttributes).forEach(function(key) {
            const val = cleanText(String(pdp.articleAttributes[key]));
            if (val && val !== 'NA') attributes[key] = val;
        });
    }
    if (availableSizeLabels.length > 0) {
        attributes['Available Sizes'] = availableSizeLabels.join(', ');
    }

    return withDefaults({
        marketplace: 'myntra',
        externalId: pid,
        title,
        brand,
        images: gallery.slice(0, config.product.maxImages),
        currentPrice,
        originalPrice,
        currency: 'INR',
        rating: { average: rating, reviews },
        availability: inStock ? 'in_stock' : 'out_of_stock',
        rawUrl: cleanProductUrl(url),
        keywords: buildKeywords(title),
        attributes,
        fetchedVia: 'scraper',
    });
}

function parseProductPageFromCheerio(html, url) {
    const $ = cheerio.load(html);

    const title = cleanText($('h1.pdp-title, h1.pdp-name, [class*="pdp-title"]').first().text());
    if (!title) return null;

    const currentPrice = toNum($('.pdp-price strong, [class*="pdp-price"]').first().text());
    if (currentPrice === null) return null;

    const pid = extractMyntraId(url);
    if (!pid) return null;

    const brand = cleanText($('.pdp-title strong, [class*="pdp-brand"]').first().text()) || extractBrand(title);

    const gallery = [];
    $('img[class*="image-grid-image"], img[class*="pdp-image"]').each(function(_, el) {
        const src = $(el).attr('src');
        if (src) gallery.push(src);
    });

    return withDefaults({
        marketplace: 'myntra',
        externalId: pid,
        title,
        brand,
        images: gallery.slice(0, config.product.maxImages),
        currentPrice,
        originalPrice: toNum($('.pdp-mrp s, [class*="pdp-mrp"]').first().text()),
        currency: 'INR',
        rawUrl: cleanProductUrl(url),
        keywords: buildKeywords(title),
        fetchedVia: 'scraper',
    });
}

// ── Public contract ─────────────────────────────────────────────────

async function searchByQuery(query) {
    const slug = query.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    const url = BASE + '/' + slug;

    let html;
    try {
        html = await fetchHtml(url, BASE);
    } catch (err) {
        logger.error('Myntra scraper: search request failed', { query, message: err.message });
        throw err;
    }

    const state = extractMyxState(html);
    let results = state ? parseSearchResultsFromState(state, query) : null;
    if (!results) {
        results = parseSearchResultsFromCheerio(html);
    }

    logger.info('Myntra scraper search finished', { query, count: results.length });

    return validateProviderProductList(results);
}

async function searchByLink(url) {
    let html;
    try {
        html = await fetchHtml(url, BASE + '/');
    } catch (err) {
        logger.error('Myntra scraper: product page request failed', { url, message: err.message });
        throw err;
    }

    const state = extractMyxState(html);
    let result = null;

    if (state) {
        const pdp = state.pdpData || state.pageData || state.data;
        if (pdp) {
            result = parseProductPageFromState(pdp, url);
        }
    }

    if (!result) {
        result = parseProductPageFromCheerio(html, url);
    }

    if (!result) {
        logger.warn('Myntra scraper: could not extract product details', { url });
        return null;
    }

    logger.info('Myntra scraper product-detail finished', { url });

    return validateProviderProduct(result);
}

module.exports = { searchByQuery, searchByLink };