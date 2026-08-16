// src/adapters/flipkart/flipkart.api.js
//
// Official-API Flipkart adapter, backed by RapidAPI's "Real-Time
// Flipkart Data2" endpoint. Satisfies the same contract as the scraper
// adapter (see provider.interface.js).

'use strict';

const config = require('../../config/env');
const logger = require('../../utils/logger');
const { rapidApiGet } = require('../shared/rapidApiClient');
const { withDefaults, validateProviderProduct, validateProviderProductList } = require('../provider.interface');

const BASE = 'https://real-time-flipkart-data2.p.rapidapi.com';
const MAX_SEARCH_RESULTS = config.apiSearch.maxResults;

// /product-details requires a pincode (affects delivery estimate only,
// not product identity/price). Hardcoded default for now - candidate
// for an env var later if regional delivery accuracy matters.
const DEFAULT_PINCODE = '400001';

function getCredentials() {
    return {
        key: config.providerApis.flipkart.key,
        host: config.providerApis.flipkart.host,
    };
}

// ── Parsing helpers ──────────────────────────────────────────────────

function parsePrice(value) {
    if (value === null || value === undefined) return null;
    const n = typeof value === 'number' ? value : parseFloat(String(value).replace(/[^0-9.]/g, ''));
    return Number.isNaN(n) ? null : n;
}

// "IN_STOCK" -> "in_stock", matching our AVAILABILITY_VALUES enum.
function mapAvailability(value) {
    if (!value) return 'unknown';
    const normalized = String(value).toLowerCase();
    const known = ['in_stock', 'out_of_stock', 'limited', 'preorder'];
    return known.indexOf(normalized) !== -1 ? normalized : 'unknown';
}

// Only used to build the /product-details REQUEST param below - the
// externalId this adapter actually persists always comes from the
// response itself (item.pid / data.pid), never from this guess. Used to
// also fall back to matching the /p/<id> PATH segment, but that segment
// is Flipkart's item id, NOT its pid - a genuinely different identifier
// (confirmed against a real product page: its pid, embedded in the page's
// own JSON, does not match its uppercased item-id). Sending that wrong
// guess to RapidAPI as "pid" risked silently fetching a different
// product's details entirely - see flipkart.scraper.js's matching fix
// for the sibling bug this caused there (duplicate Product documents).
// Failing cleanly (null) when the URL has no ?pid= is the safer behavior.
function extractPidFromUrl(url) {
    const queryMatch = url.match(/[?&]pid=([A-Z0-9]+)/i);
    if (queryMatch) return queryMatch[1].toUpperCase();
    return null;
}

function buildKeywords(title) {
    if (!title) return [];
    return String(title)
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(function(word) { return word.length > 1; })
        .slice(0, 20);
}

// ── Mapping: a single /product-search result item -> ProviderProduct ──

function mapSearchItem(item) {
    const currentPrice = parsePrice(item.price);
    if (currentPrice === null || !item.pid) return null;

    return withDefaults({
        marketplace: 'flipkart',
        externalId: item.pid,
        sku: item.itemId || null,
        title: item.title,
        brand: item.brand || null,
        images: Array.isArray(item.images) ? item.images.slice(0, config.product.maxImages) : [],
        currentPrice,
        originalPrice: parsePrice(item.mrp),
        currency: 'INR',
        rating: {
            average: (item.rating && item.rating.average) || null,
            reviews: (item.rating && item.rating.count) || null,
        },
        availability: mapAvailability(item.availability),
        rawUrl: item.url,
        keywords: buildKeywords(item.title),
        fetchedVia: 'api',
        metadata: {
            isSponsored: item.isSponsored || false,
            listingId: item.listingId || null,
        },
    });
}

// ── Mapping: a /product-details response -> ProviderProduct ───────────
// NOTE: this endpoint returns a genuinely thinner object than
// /product-search - no images, no rating, no availability. Mapped
// honestly (those fields come back null/empty), not invented. See file
// header comment for the reasoning.

function mapProductDetail(data) {
    const currentPrice = parsePrice(data.specialPrice !== undefined ? data.specialPrice : data.price);
    if (currentPrice === null || !data.pid) return null;

    return withDefaults({
        marketplace: 'flipkart',
        externalId: data.pid,
        sku: data.itemId || null,
        title: data.title,
        brand: data.brand || null,
        currentPrice,
        originalPrice: parsePrice(data.mrp),
        currency: 'INR',
        rawUrl: data.url,
        keywords: buildKeywords(data.title),
        fetchedVia: 'api',
        metadata: {
            listingId: data.listingId || null,
        },
    });
}

// ── Public contract ─────────────────────────────────────────────────

async function searchByQuery(query, options) {
    const creds = getCredentials();
    const page = (options && options.page) || 1;

    const raw = await rapidApiGet(
        BASE + '/product-search', { q: query, page: String(page), sort_by: 'RELEVANCE' },
        creds.key,
        creds.host
    );

    const items = (raw.data && Array.isArray(raw.data.products)) ? raw.data.products : [];

    const mapped = items
        .map(mapSearchItem)
        .filter(Boolean)
        .slice(0, MAX_SEARCH_RESULTS);

    logger.info('Flipkart API search finished', { query, count: mapped.length });

    return validateProviderProductList(mapped);
}

async function searchByLink(url) {
    const pid = extractPidFromUrl(url);
    if (!pid) {
        logger.warn('Flipkart API: could not extract pid from URL', { url });
        return null;
    }

    const creds = getCredentials();

    const raw = await rapidApiGet(
        BASE + '/product-details', { pid, pincode: DEFAULT_PINCODE },
        creds.key,
        creds.host
    );

    if (!raw.data) {
        return null;
    }

    const mapped = mapProductDetail(raw.data);
    if (!mapped) {
        return null;
    }

    logger.info('Flipkart API product-details finished', { pid });

    return validateProviderProduct(mapped);
}

module.exports = { searchByQuery, searchByLink };