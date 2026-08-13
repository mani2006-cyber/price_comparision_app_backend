// src/adapters/nykaa/nykaa.scraper.js
//
// Scraper-only Nykaa adapter - no official API exists, so this is the
// sole implementation (nykaa/index.js just re-exports it), same
// reasoning as adapters/lenskart and adapters/myntra.
//
// Two real, independent findings this file relies on (verified against
// live Nykaa pages during the src/scraper research spike - see
// src/scraper/src/connectors/nykaa/ for the fixture-backed source of
// truth this was ported from):
//   1. Nykaa's free-text search RESULTS page ("/search/result/") is
//      robots.txt-disallowed. "/gludo/searchSuggestions?q=" is a
//      different, allowed autocomplete endpoint that returns product
//      cards - but WITHOUT price. searchByQuery therefore has to fetch
//      each candidate's product page to get a price at all (a required
//      ProviderProduct field), fanned out in parallel and best-effort
//      (a candidate whose page fails to parse is dropped, not fatal to
//      the batch).
//   2. Product pages carry price/title/brand/images/availability in a
//      standard JSON-LD "Product" block, and MRP/discount/rating/seller
//      only in an embedded `window.__PRELOADED_STATE__` blob (no
//      __NEXT_DATA__ on this site). JSON-LD is primary; the preloaded
//      state is a genuine fallback/supplement, not dead code.

'use strict';

const axios = require('axios');
const logger = require('../../utils/logger');
const { withDefaults, validateProviderProduct, validateProviderProductList } = require('../provider.interface');

const BASE = 'https://www.nykaa.com';
const MAX_SEARCH_RESULTS = 8;

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
        timeout: 20000,
        decompress: true,
        maxRedirects: 5,
    });
    return response.data;
}

async function fetchJson(url) {
    const response = await axios.get(url, {
        headers: Object.assign(getHeaders(BASE), { Accept: 'application/json' }),
        timeout: 20000,
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

// Quote-style-agnostic <script type="application/ld+json"> extraction,
// flattened (a block containing a JSON array contributes each element
// individually). A block that fails to parse is skipped, not fatal.
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

function categoryFromBreadcrumb(breadcrumb) {
    const items = (breadcrumb && breadcrumb.itemListElement) || [];
    if (items.length <= 1) return null;
    const leaf = items[items.length - 1];
    return cleanText(leaf && leaf.name);
}

function brandFromJsonLd(brand) {
    if (typeof brand === 'string' && brand.length > 0) return brand;
    if (isRecord(brand) && typeof brand.name === 'string') return brand.name || null;
    return null;
}

function imagesFromJsonLd(image) {
    if (typeof image === 'string') return [image];
    if (Array.isArray(image)) return image.filter(function(i) { return typeof i === 'string'; });
    return [];
}

function mapAvailability(schemaOrgValue) {
    if (!schemaOrgValue) return null;
    const normalized = String(schemaOrgValue).toLowerCase().replace(/^https?:\/\/schema\.org\//, '');
    if (normalized === 'instock') return 'in_stock';
    if (normalized === 'outofstock') return 'out_of_stock';
    if (normalized === 'preorder') return 'preorder';
    return null;
}

// Extracts window.__PRELOADED_STATE__ = {...}; -> productPage.product.
// Bounded to the first </script> after the marker (the assignment is
// always the sole statement in its own script tag). Returns null (never
// throws) on anything unexpected - dependent fields then just fall back
// to their JSON-LD value or stay unset, never a wrong value substituted.
const PRELOADED_STATE_MARKER = 'window.__PRELOADED_STATE__ = ';

function extractPreloadedProduct(html) {
    const markerIndex = html.indexOf(PRELOADED_STATE_MARKER);
    if (markerIndex === -1) return null;

    const jsonStart = markerIndex + PRELOADED_STATE_MARKER.length;
    const scriptEnd = html.indexOf('</script>', jsonStart);
    if (scriptEnd === -1) return null;

    let jsonText = html.slice(jsonStart, scriptEnd).trim();
    if (jsonText.endsWith(';')) jsonText = jsonText.slice(0, -1);

    try {
        const parsed = JSON.parse(jsonText);
        return (parsed.productPage && parsed.productPage.product) || null;
    } catch (err) {
        return null;
    }
}

// ── Product page parsing ─────────────────────────────────────────────

function parseProductPage(html, url) {
    const jsonLdValues = extractJsonLdValues(html);
    const product = findJsonLdByType(jsonLdValues, 'Product');
    if (!product || !product.sku || !product.name) return null;

    const preloaded = extractPreloadedProduct(html);

    // JSON-LD offers.price is primary; __PRELOADED_STATE__'s offerPrice
    // is the documented fallback.
    let currentPrice = toNum(product.offers && product.offers.price);
    if (currentPrice === null && preloaded) {
        currentPrice = toNum(preloaded.offerPrice);
    }
    if (currentPrice === null) return null;

    // MRP has exactly one real source - the preloaded-state blob.
    const originalPrice = preloaded ? toNum(preloaded.mrp) : null;

    let availability = mapAvailability(product.offers && product.offers.availability);
    if (!availability && preloaded && preloaded.inStock !== undefined) {
        availability = preloaded.inStock ? 'in_stock' : 'out_of_stock';
    }

    const breadcrumb = findJsonLdByType(jsonLdValues, 'BreadcrumbList');

    const attributes = {};
    if (preloaded && preloaded.variantType && preloaded.selectedVariantName) {
        attributes[preloaded.variantType] = preloaded.selectedVariantName;
    }

    return withDefaults({
        marketplace: 'nykaa',
        externalId: String(product.sku),
        title: cleanText(product.name),
        brand: brandFromJsonLd(product.brand),
        category: categoryFromBreadcrumb(breadcrumb),
        images: imagesFromJsonLd(product.image).slice(0, 10),
        currentPrice,
        originalPrice,
        currency: ((product.offers && product.offers.priceCurrency) || 'INR').toUpperCase(),
        rating: {
            average: preloaded ? toNum(preloaded.rating) : null,
            reviews: preloaded ? toNum(preloaded.ratingCount) : null,
        },
        seller: { name: (preloaded && preloaded.sellerName) || null, rating: null },
        availability: availability || 'unknown',
        rawUrl: url,
        keywords: buildKeywords(cleanText(product.name)),
        attributes,
        fetchedVia: 'scraper',
    });
}

// ── Public contract ─────────────────────────────────────────────────

// The search-suggestions endpoint carries no price, so each candidate's
// product page is fetched to fill in the required field - best-effort,
// parallel (Promise.allSettled), a failing candidate is dropped rather
// than failing the whole search.
async function searchByQuery(query) {
    const suggestUrl = BASE + '/gludo/searchSuggestions?q=' + encodeURIComponent(query);

    let json;
    try {
        json = await fetchJson(suggestUrl);
    } catch (err) {
        logger.error('Nykaa scraper: search-suggestions request failed', { query, message: err.message });
        throw err;
    }

    const suggestions = (json && json.suggestions) || [];
    const candidates = suggestions
        .filter(function(s) { return s.type === 'product' && s.id && s.slug && s.q; })
        .slice(0, MAX_SEARCH_RESULTS);

    const settled = await Promise.allSettled(
        candidates.map(function(c) {
            const productUrl = new URL(c.slug, BASE + '/').toString();
            return fetchHtml(productUrl, BASE).then(function(html) {
                return parseProductPage(html, productUrl);
            });
        })
    );

    const results = [];
    settled.forEach(function(outcome) {
        if (outcome.status === 'fulfilled' && outcome.value) results.push(outcome.value);
    });

    logger.info('Nykaa scraper search finished', { query, count: results.length });

    return validateProviderProductList(results);
}

async function searchByLink(url) {
    let html;
    try {
        html = await fetchHtml(url, BASE + '/');
    } catch (err) {
        logger.error('Nykaa scraper: product page request failed', { url, message: err.message });
        throw err;
    }

    const result = parseProductPage(html, url);
    if (!result) {
        logger.warn('Nykaa scraper: could not extract product details', { url });
        return null;
    }

    logger.info('Nykaa scraper product-detail finished', { url });

    return validateProviderProduct(result);
}

module.exports = { searchByQuery, searchByLink };
