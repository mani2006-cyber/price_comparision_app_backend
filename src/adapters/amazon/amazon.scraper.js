// src/adapters/amazon/amazon.scraper.js
//
// Scraper implementation of the Amazon adapter. This is the fallback
// path in "auto" mode (see AMAZON_PROVIDER_MODE), and the primary path
// in "scraper" mode. Satisfies the exact same contract as
// amazon.api.js - the service layer cannot tell which one produced a
// given result.

'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const logger = require('../../utils/logger');
const { withDefaults, validateProviderProduct, validateProviderProductList } = require('../provider.interface');

const BASE = 'https://www.amazon.in';
const MAX_SEARCH_RESULTS = 8;

function getHeaders(referer) {
    return {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/124.0.6367.207 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,' +
            'image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
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

// ── Helpers ──────────────────────────────────────────────────────────

function toNum(str) {
    if (str === null || str === undefined) return null;
    const n = parseFloat(String(str).replace(/[^0-9.]/g, ''));
    return Number.isNaN(n) ? null : n;
}

function cleanText(str) {
    return (str || '').replace(/\s+/g, ' ').trim() || null;
}

function absoluteUrl(href) {
    if (!href) return null;
    return href.startsWith('http') ? href : BASE + href;
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
    return title
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(function(word) { return word.length > 1; })
        .slice(0, 20);
}

// ── Search page parsing ─────────────────────────────────────────────

function parseSearchResults(html) {
    const $ = cheerio.load(html);
    const results = [];

    const items = $('div[data-component-type="s-search-result"]').toArray();

    for (let i = 0; i < items.length && results.length < MAX_SEARCH_RESULTS; i++) {
        const el = $(items[i]);

        const titleLink = el.find('div[data-cy="title-recipe"] a.a-link-normal').first();
        const title = cleanText(titleLink.find('h2 span').first().text());
        if (!title) continue; // skip sponsored/empty cards with no real title

        const relativeUrl = titleLink.attr('href') || '';
        const productUrl = absoluteUrl(relativeUrl.split('?')[0]);
        const asin = extractAsinFromUrl(productUrl || '');
        if (!asin) continue; // no stable identity - skip, can't upsert this safely

        const priceWhole = el.find('.a-price .a-price-whole').first().text().replace(/[^0-9]/g, '');
        if (!priceWhole) continue; // no visible price - skip

        const currentPrice = parseFloat(priceWhole);
        const image = el.find('img.s-image').attr('src') || null;

        const ratingText = el.find('.a-icon-alt').first().text();
        const ratingMatch = ratingText.match(/(\d+(?:\.\d+)?)/);
        const reviewCountText = el.find('[aria-label*="ratings"], .a-size-base.s-underline-text').first().text();
        const reviewCountMatch = reviewCountText.replace(/[^0-9]/g, '');

        results.push(
            withDefaults({
                marketplace: 'amazon',
                externalId: asin,
                title,
                images: image ? [image] : [],
                currentPrice,
                currency: 'INR',
                rating: {
                    average: ratingMatch ? parseFloat(ratingMatch[1]) : null,
                    reviews: reviewCountMatch ? parseInt(reviewCountMatch, 10) : null,
                },
                rawUrl: productUrl,
                keywords: buildKeywords(title),
                fetchedVia: 'scraper',
            })
        );
    }

    return results;
}

// ── Product detail page parsing ─────────────────────────────────────

function parseProductDetail(html, productUrl) {
    const $ = cheerio.load(html);

    const title = cleanText($('#productTitle').first().text());
    if (!title) return null;

    const priceContainer = $('#corePriceDisplay_desktop_feature_div');
    let priceText = priceContainer.find('.a-price-whole').first().text();
    // Fallback selector - Amazon's markup varies between product page
    // types; this covers pages where the desktop feature div isn't present.
    if (!priceText) {
        priceText = $('.a-price .a-price-whole').first().text();
    }
    const priceDigits = priceText.replace(/[^0-9]/g, '');
    if (!priceDigits) return null;

    const currentPrice = parseFloat(priceDigits);

    const bylineText = cleanText($('#bylineInfo').first().text()) || '';
    const brandMatch = bylineText.match(/Visit the (.+?) Store/i);
    const brand = brandMatch ? brandMatch[1] : title.split(' ')[0];

    const images = [];
    $('#altImages img').each(function() {
        const src = $(this).attr('src');
        if (src) images.push(src.replace(/\._[A-Z0-9,_]+_\./, '.')); // strip Amazon's thumbnail-size suffix
    });
    if (images.length === 0) {
        const mainImage = $('#landingImage').attr('src');
        if (mainImage) images.push(mainImage);
    }

    const ratingText = $('#acrPopover').attr('title') || '';
    const ratingMatch = ratingText.match(/(\d+(?:\.\d+)?)/);
    const reviewCountText = cleanText($('#acrCustomerReviewText').first().text()) || '';
    const reviewCountMatch = reviewCountText.replace(/[^0-9]/g, '');

    const availabilityText = cleanText($('#availability').first().text()) || '';
    let availability = 'unknown';
    if (availabilityText) {
        const lower = availabilityText.toLowerCase();
        if (lower.indexOf('in stock') !== -1) availability = 'in_stock';
        else if (lower.indexOf('out of stock') !== -1 || lower.indexOf('unavailable') !== -1) availability = 'out_of_stock';
    }

    const asin = extractAsinFromUrl(productUrl);
    if (!asin) return null;

    return withDefaults({
        marketplace: 'amazon',
        externalId: asin,
        title,
        brand,
        images: images.slice(0, 10),
        currentPrice,
        currency: 'INR',
        rating: {
            average: ratingMatch ? parseFloat(ratingMatch[1]) : null,
            reviews: reviewCountMatch ? parseInt(reviewCountMatch, 10) : null,
        },
        availability,
        rawUrl: productUrl,
        keywords: buildKeywords(title),
        fetchedVia: 'scraper',
    });
}

// ── Public contract ─────────────────────────────────────────────────

async function searchByQuery(query) {
    const url = BASE + '/s?k=' + encodeURIComponent(query);

    let html;
    try {
        html = await fetchHtml(url, BASE);
    } catch (err) {
        logger.error('Amazon scraper: search request failed', { query, message: err.message });
        throw err; // let the caller (auto-mode orchestrator, or the service) decide what to do
    }

    const results = parseSearchResults(html);
    logger.info('Amazon scraper search finished', { query, count: results.length });

    return validateProviderProductList(results);
}

async function searchByLink(url) {
    let html;
    try {
        html = await fetchHtml(url, BASE);
    } catch (err) {
        logger.error('Amazon scraper: product page request failed', { url, message: err.message });
        throw err;
    }

    const result = parseProductDetail(html, url);
    if (!result) {
        logger.warn('Amazon scraper: could not extract product details', { url });
        return null;
    }

    logger.info('Amazon scraper product-detail finished', { url });

    return validateProviderProduct(result);
}

module.exports = { searchByQuery, searchByLink };