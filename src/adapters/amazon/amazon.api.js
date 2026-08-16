// src/adapters/amazon/amazon.api.js
//
// Official-API Amazon adapter, backed by RapidAPI's "Real-Time Amazon
// Data" endpoint. Satisfies the same contract as the scraper adapter
// (see provider.interface.js) - the service layer cannot tell which one
// produced a given result.

'use strict';

const config = require('../../config/env');
const logger = require('../../utils/logger');
const { rapidApiGet } = require('../shared/rapidApiClient');
const { withDefaults, validateProviderProduct, validateProviderProductList } = require('../provider.interface');

const BASE = 'https://real-time-amazon-data.p.rapidapi.com';
const MAX_SEARCH_RESULTS = config.apiSearch.maxResults;

function getCredentials() {
    return {
        key: config.providerApis.amazon.key,
        host: config.providerApis.amazon.host,
        country: config.providerApis.amazon.country,
    };
}

// ── Parsing helpers ──────────────────────────────────────────────────

function parsePrice(value) {
    if (value === null || value === undefined) return null;
    const cleaned = String(value).replace(/[^0-9.]/g, '');
    if (cleaned === '') return null;
    const n = parseFloat(cleaned);
    return Number.isNaN(n) ? null : n;
}

function parseRating(value) {
    if (value === null || value === undefined) return null;
    const n = parseFloat(value);
    return Number.isNaN(n) ? null : n;
}

// Turns "Brand: Nike" or "Visit the Nike Store" into "Nike".
function extractBrand(byline, fallbackTitle) {
    if (byline) {
        const brandMatch = String(byline).match(/Brand:\s*(.+)/i) || String(byline).match(/Visit the (.+) Store/i);
        if (brandMatch) return brandMatch[1].trim();
    }
    if (fallbackTitle) {
        return String(fallbackTitle).split(' ')[0];
    }
    return null;
}

// Maps the API's free-text availability sentence to our fixed enum.
function mapAvailability(text) {
    if (!text) return 'unknown';
    const lower = String(text).toLowerCase();
    if (lower.indexOf('out of stock') !== -1 || lower.indexOf('unavailable') !== -1) return 'out_of_stock';
    if (lower.indexOf('left in stock') !== -1 || lower.indexOf('only') !== -1) return 'limited';
    if (lower.indexOf('in stock') !== -1 || lower.indexOf('order soon') !== -1) return 'in_stock';
    return 'unknown';
}

function extractAsinFromUrl(url) {
    const dpMatch = url.match(/\/dp\/([A-Z0-9]{10})/i);
    if (dpMatch) return dpMatch[1].toUpperCase();

    const gpMatch = url.match(/\/gp\/product\/([A-Z0-9]{10})/i);
    if (gpMatch) return gpMatch[1].toUpperCase();

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

// ── Mapping: a single /search result item -> ProviderProduct ──────────

function mapSearchItem(item) {
    const currentPrice = parsePrice(item.product_price);
    if (currentPrice === null) return null; // no usable price - skip, same as the old scraper's rule

    return withDefaults({
        marketplace: 'amazon',
        externalId: item.asin,
        title: item.product_title,
        brand: extractBrand(null, item.product_title),
        images: item.product_photo ? [item.product_photo] : [],
        currentPrice,
        originalPrice: parsePrice(item.product_original_price),
        currency: item.currency || 'INR',
        rating: {
            average: parseRating(item.product_star_rating),
            reviews: item.product_num_ratings || null,
        },
        availability: 'unknown', // /search doesn't return availability text - only /product-details does
        rawUrl: item.product_url,
        keywords: buildKeywords(item.product_title),
        fetchedVia: 'api',
        metadata: {
            isPrime: item.is_prime || false,
            isAmazonChoice: item.is_amazon_choice || false,
            isBestSeller: item.is_best_seller || false,
            salesVolume: item.sales_volume || null,
        },
    });
}

// ── Mapping: a /product-details response -> ProviderProduct ───────────

function mapProductDetail(data) {
    const currentPrice = parsePrice(data.product_price);
    if (currentPrice === null) return null;

    const categoryPath = Array.isArray(data.category_path) ?
        data.category_path.map(function(c) { return c.name; }).filter(Boolean) :
        [];

    const images = Array.isArray(data.product_photos) && data.product_photos.length > 0 ?
        data.product_photos.slice(0, config.product.maxImages) :
        (data.product_photo ? [data.product_photo] : []);

    return withDefaults({
        marketplace: 'amazon',
        externalId: data.asin,
        title: data.product_title,
        brand: extractBrand(data.product_byline, data.product_title),
        category: categoryPath.length > 0 ? categoryPath[categoryPath.length - 1] : null,
        categoryPath,
        images,
        currentPrice,
        originalPrice: parsePrice(data.product_original_price),
        currency: data.currency || 'INR',
        rating: {
            average: parseRating(data.product_star_rating),
            reviews: data.product_num_ratings || null,
        },
        availability: mapAvailability(data.product_availability),
        delivery: { estimate: data.delivery || data.primary_delivery_time || null, free: null },
        rawUrl: data.product_url,
        keywords: buildKeywords(data.product_title),
        fetchedVia: 'api',
        metadata: {
            isPrime: data.is_prime || false,
            isAmazonChoice: data.is_amazon_choice || false,
            isBestSeller: data.is_best_seller || false,
            salesVolume: data.sales_volume || null,
            aboutProduct: data.about_product || [],
        },
    });
}

// ── Public contract ─────────────────────────────────────────────────

async function searchByQuery(query, options) {
    const creds = getCredentials();
    const page = (options && options.page) || 1;

    const raw = await rapidApiGet(
        BASE + '/search', { query, page: String(page), country: creds.country, sort_by: 'RELEVANCE' },
        creds.key,
        creds.host
    );

    const items = (raw.data && Array.isArray(raw.data.products)) ? raw.data.products : [];

    const mapped = items
        .map(mapSearchItem)
        .filter(Boolean) // drop items with no usable price
        .slice(0, MAX_SEARCH_RESULTS);

    logger.info('Amazon API search finished', { query, count: mapped.length });

    return validateProviderProductList(mapped);
}

async function searchByLink(url) {
    const asin = extractAsinFromUrl(url);
    if (!asin) {
        logger.warn('Amazon API: could not extract ASIN from URL', { url });
        return null;
    }

    const creds = getCredentials();

    const raw = await rapidApiGet(
        BASE + '/product-details', { asin, country: creds.country },
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

    logger.info('Amazon API product-details finished', { asin });

    return validateProviderProduct(mapped);
}

module.exports = { searchByQuery, searchByLink };