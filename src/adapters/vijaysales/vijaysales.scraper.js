// src/adapters/vijaysales/vijaysales.scraper.js
//
// Scraper-only Vijay Sales adapter - no official API exists, so this
// is the sole implementation (vijaysales/index.js just re-exports it),
// same reasoning as adapters/lenskart and adapters/myntra.
//
// Ported from the fixture-backed research in
// src/scraper/src/connectors/vijaysales/ (a separate, standalone
// project in this repo - see that connector's parse.ts/search.ts for
// the full evidence trail this was verified against):
//   - Vijay Sales' own search-listing page is client-side rendered and
//     carries no product data server-side. The real data source is
//     Unbxd, a third-party search-as-a-service platform the storefront
//     itself calls; its public apiKey/siteKey are embedded as hidden
//     <input> elements on every Vijay Sales page (client-side-use
//     credentials, not secrets). searchByQuery does two GETs: fetch
//     any page to read those credentials, then call Unbxd's own search
//     endpoint directly - which conveniently returns price/mrp inline,
//     unlike Nykaa's search endpoint.
//   - Product pages carry title/images/description/brand/sku/price/
//     availability in a JSON-LD "Product" block. MRP and the retailer's
//     own discount-percent claim are NOT in JSON-LD (schema.org's Offer
//     has no "original price" concept) - MRP falls back to a
//     `data-mrp="<rupees>"` attribute rendered on the price block.
//   - Availability's schema.org URI uses non-standard casing on this
//     site ("OutofStock", not "OutOfStock") - matched case-insensitively.

'use strict';

const axios = require('axios');
const logger = require('../../utils/logger');
const config = require('../../config/env');
const { withDefaults, validateProviderProduct, validateProviderProductList } = require('../provider.interface');

const BASE = 'https://www.vijaysales.com';
const UNBXD_SEARCH_HOST = 'https://search.unbxd.io';

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

async function fetchJson(url) {
    const response = await axios.get(url, {
        headers: Object.assign(getHeaders(BASE), { Accept: 'application/json' }),
        timeout: config.scraper.timeoutMs,
        decompress: true,
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

function isRecord(val) {
    return val !== null && typeof val === 'object';
}

// Quote-style-agnostic - Vijay Sales' own product pages use single-quoted
// type='application/ld+json' on at least some pages.
const JSON_LD_SCRIPT_RE = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

function extractJsonLdValues(html) {
    const values = [];
    let match;
    while ((match = JSON_LD_SCRIPT_RE.exec(html)) !== null) {
        try {
            const parsed = JSON.parse(match[1]);
            if (Array.isArray(parsed)) values.push.apply(values, parsed);
            else values.push(parsed);
        } catch (err) { /* one broken block must not take down the others */ }
    }
    return values;
}

function findJsonLdByType(values, type) {
    for (let i = 0; i < values.length; i++) {
        if (isRecord(values[i]) && values[i]['@type'] === type) return values[i];
    }
    return null;
}

// Root-first, excluding the site root ("Home") AND the leaf (always the
// product's own name on this site, not a category).
function categoryFromBreadcrumb(breadcrumb) {
    const items = (breadcrumb && breadcrumb.itemListElement) || [];
    if (items.length <= 2) return null;
    const mid = items[items.length - 2];
    return cleanText(mid && mid.name);
}

function imagesFromJsonLd(image) {
    if (typeof image === 'string') return [image];
    if (Array.isArray(image)) return image.filter(function(i) { return typeof i === 'string'; });
    return [];
}

// Non-standard casing on this site's own JSON-LD ("OutofStock") -
// matched case-insensitively rather than assuming schema.org's exact form.
function mapAvailability(schemaOrgUri) {
    if (!schemaOrgUri) return null;
    const normalized = String(schemaOrgUri).toLowerCase();
    if (normalized.indexOf('/instock') !== -1) return 'in_stock';
    if (normalized.indexOf('/outofstock') !== -1) return 'out_of_stock';
    if (normalized.indexOf('/preorder') !== -1) return 'preorder';
    return null;
}

// `data-mrp="11990"` - rendered on the price block, only real source
// for MRP since JSON-LD carries no original-price concept. Matches the
// whole tag so an "offer" price badge (a separate, conditional-price
// concept) can be told apart from the genuine MRP block.
const MRP_TAG_RE = /<[^>]*\bdata-mrp="([\d.]+)"[^>]*>/;

function extractMrp(html) {
    const m = MRP_TAG_RE.exec(html);
    return m ? toNum(m[1]) : null;
}

const DISCOUNT_LABEL_RE = /product__price--discount-label"[^>]*>\s*([\d.]+)%\s*off/i;

function extractDiscountPercent(html) {
    const m = DISCOUNT_LABEL_RE.exec(html);
    return m ? toNum(m[1]) : null;
}

function hiddenInputValue(html, id) {
    const tagMatch = new RegExp('<input[^>]+id=["\']' + id + '["\'][^>]*>', 'i').exec(html);
    if (!tagMatch) return null;
    const valueMatch = /value=["']([^"']*)["']/.exec(tagMatch[0]);
    return valueMatch ? valueMatch[1] : null;
}

// ── Product page parsing ─────────────────────────────────────────────

function parseProductPage(html, url) {
    const jsonLdValues = extractJsonLdValues(html);
    const product = findJsonLdByType(jsonLdValues, 'Product');
    if (!product || !product.sku || !product.name) return null;

    const currentPrice = toNum(product.offers && product.offers.price);
    if (currentPrice === null) return null;

    const originalPriceRaw = extractMrp(html);
    const originalPrice = (originalPriceRaw !== null && originalPriceRaw > currentPrice) ? originalPriceRaw : null;

    const breadcrumb = findJsonLdByType(jsonLdValues, 'BreadcrumbList');

    return withDefaults({
        marketplace: 'vijaysales',
        externalId: String(product.sku),
        title: cleanText(product.name),
        brand: cleanText(product.brand && product.brand.name),
        category: categoryFromBreadcrumb(breadcrumb),
        images: imagesFromJsonLd(product.image).slice(0, config.product.maxImages),
        currentPrice,
        originalPrice,
        discountPercentage: extractDiscountPercent(html),
        currency: ((product.offers && product.offers.priceCurrency) || 'INR').toUpperCase(),
        availability: mapAvailability(product.offers && product.offers.availability) || 'unknown',
        rawUrl: url,
        keywords: buildKeywords(cleanText(product.name)),
        fetchedVia: 'scraper',
    });
}

// ── Search (Unbxd) ───────────────────────────────────────────────────

async function fetchUnbxdCredentials() {
    // Any real page carries the credentials - the search-listing page
    // itself is the natural, on-topic choice.
    const html = await fetchHtml(BASE + '/search-listing?q=search', BASE);
    const apiKey = hiddenInputValue(html, 'unbxd-apiKey');
    const siteKey = hiddenInputValue(html, 'unbxd-siteKey');
    if (!apiKey || !siteKey) return null;
    return { apiKey, siteKey };
}

// Real gap found live: search results never carried a category at all,
// even though Unbxd's own response already has one - l1..l4 are plain
// strings, each one level deeper ("Electronics" -> "Television and
// Entertainment" -> "Large Audio" -> "Party Speakers"), confirmed
// against a real live response. Reading it here is free (no extra
// request - unlike Poorvika, whose search cards carry no category
// signal at all, or Amazon's /search endpoint, which just doesn't
// return one - both would need an extra per-result page fetch to get
// one, which isn't worth the added request volume/block risk for this
// site, where the data's already sitting in the response being parsed).
function categoryFromUnbxdProduct(p) {
    const path = [p.l1, p.l2, p.l3, p.l4].filter(function(level) {
        return typeof level === 'string' && level.trim().length > 0;
    });
    return { category: path.length > 0 ? path[path.length - 1] : null, categoryPath: path };
}

function parseUnbxdResults(json) {
    const products = (json && json.response && json.response.products) || [];
    const results = [];

    products.forEach(function(p) {
        if (!p.sku || !p.title || !p.productUrl || typeof p.price !== 'number') return;

        const category = categoryFromUnbxdProduct(p);

        results.push(
            withDefaults({
                marketplace: 'vijaysales',
                externalId: String(p.sku),
                title: cleanText(p.title),
                category: category.category,
                categoryPath: category.categoryPath,
                images: p.thumbnailImage ? [p.thumbnailImage] : [],
                currentPrice: p.price,
                originalPrice: typeof p.mrp === 'number' && p.mrp > p.price ? p.mrp : null,
                currency: 'INR',
                // Unbxd's index carries no stock/quantity field.
                availability: 'unknown',
                rawUrl: p.productUrl,
                keywords: buildKeywords(cleanText(p.title)),
                fetchedVia: 'scraper',
            })
        );
    });

    return results;
}

// ── Public contract ─────────────────────────────────────────────────

async function searchByQuery(query, options) {
    const pageSize = (options && options.pageSize) || 24;

    let credentials;
    try {
        credentials = await fetchUnbxdCredentials();
    } catch (err) {
        logger.error('Vijay Sales scraper: failed to discover Unbxd credentials', { query, message: err.message });
        throw err;
    }

    if (!credentials) {
        logger.warn('Vijay Sales scraper: Unbxd credentials not found on page, skipping search', { query });
        return [];
    }

    const searchUrl = UNBXD_SEARCH_HOST + '/' + credentials.apiKey + '/' + credentials.siteKey + '/search' +
        '?q=' + encodeURIComponent(query) + '&rows=' + pageSize + '&start=0';

    let json;
    try {
        json = await fetchJson(searchUrl);
    } catch (err) {
        logger.error('Vijay Sales scraper: Unbxd search request failed', { query, message: err.message });
        throw err;
    }

    const results = parseUnbxdResults(json);
    logger.info('Vijay Sales scraper search finished', { query, count: results.length });

    return validateProviderProductList(results);
}

async function searchByLink(url) {
    let html;
    try {
        html = await fetchHtml(url, BASE + '/');
    } catch (err) {
        logger.error('Vijay Sales scraper: product page request failed', { url, message: err.message });
        throw err;
    }

    const result = parseProductPage(html, url);
    if (!result) {
        logger.warn('Vijay Sales scraper: could not extract product details', { url });
        return null;
    }

    logger.info('Vijay Sales scraper product-detail finished', { url });

    return validateProviderProduct(result);
}

module.exports = { searchByQuery, searchByLink };
