// src/adapters/flipkart/flipkart.scraper.js
//
// Scraper implementation of the Flipkart adapter. Fallback path in
// "auto" mode, primary path in "scraper" mode. Satisfies the exact same
// contract as flipkart.api.js. externalId (pid) extraction matches the
// API adapter's logic exactly, so the same real-world product resolves
// to the same Product document regardless of which path found it.

'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const logger = require('../../utils/logger');
const { withDefaults, validateProviderProduct, validateProviderProductList } = require('../provider.interface');

const BASE = 'https://www.flipkart.com';
const MAX_SEARCH_RESULTS = 8;

function getHeaders() {
    return {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'en-IN,en;q=0.9',
    };
}

async function fetchHtml(url) {
    const response = await axios.get(url, {
        headers: getHeaders(),
        timeout: 15000,
    });
    return response.data;
}

// ── Helpers ──────────────────────────────────────────────────────────

function extractPidFromUrl(url) {
    const queryMatch = url.match(/[?&]pid=([A-Z0-9]+)/i);
    if (queryMatch) return queryMatch[1].toUpperCase();

    const pathMatch = url.match(/\/p\/([A-Z0-9]{16})(?:[/?]|$)/i);
    if (pathMatch) return pathMatch[1].toUpperCase();

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

function absoluteUrl(href) {
    if (!href) return null;
    return href.startsWith('http') ? href : BASE + href;
}

// ── Search page parsing ─────────────────────────────────────────────

function parseSearchResults(html) {
    const $ = cheerio.load(html);
    const results = [];

    // Flipkart's class names are obfuscated and change periodically - if
    // this stops matching, re-save a live search page HTML and inspect it
    // fresh, same process used to find these originally.
    const items = $('[data-id]').toArray();

    for (let i = 0; i < items.length && results.length < MAX_SEARCH_RESULTS; i++) {
        const el = $(items[i]);

        const title = el.find('div.RG5Slk').first().text().trim();
        if (!title) continue;

        const priceText = el.find('div.hZ3P6w').first().text().trim();
        const priceDigits = priceText.replace(/[^0-9]/g, '');
        if (!priceDigits) continue;

        const relativeUrl = el.find('a.k7wcnx').first().attr('href') || '';
        const productUrl = absoluteUrl(relativeUrl.split('&')[0]);
        const pid = productUrl ? extractPidFromUrl(productUrl) : null;
        if (!pid) continue; // no stable identity - skip

        const image = el.find('img').first().attr('src') || null;

        results.push(
            withDefaults({
                marketplace: 'flipkart',
                externalId: pid,
                title,
                images: image ? [image] : [],
                currentPrice: parseFloat(priceDigits),
                currency: 'INR',
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

    const h1 = $('h1').first();
    const title = h1.text().trim();
    if (!title) return null;

    // Walk forward from the title in DOCUMENT ORDER, find the first
    // element whose text is JUST a clean "₹<digits>" pattern with no
    // other nested text (avoids EMI text, struck-through original price,
    // unrelated "similar products" widgets elsewhere on the page).
    const allElements = $.root().find('*').toArray();
    const h1Index = allElements.indexOf(h1.get(0));

    let price = null;
    for (let i = h1Index + 1; i < allElements.length; i++) {
        const el = $(allElements[i]);
        const text = el.text().trim();
        const isCleanPrice = /^₹[\d,]+$/.test(text);
        const hasNestedText = el.children().toArray().some(function(c) {
            return $(c).text().trim();
        });

        if (isCleanPrice && !hasNestedText) {
            price = parseFloat(text.replace(/[^0-9]/g, ''));
            break;
        }
    }

    if (price === null) return null;

    const pid = extractPidFromUrl(productUrl);
    if (!pid) return null;

    const brand = title.split(' ')[0];

    return withDefaults({
        marketplace: 'flipkart',
        externalId: pid,
        title,
        brand,
        currentPrice: price,
        currency: 'INR',
        rawUrl: productUrl,
        keywords: buildKeywords(title),
        fetchedVia: 'scraper',
    });
}

// ── Public contract ─────────────────────────────────────────────────

async function searchByQuery(query) {
    const url = BASE + '/search?q=' + encodeURIComponent(query);

    let html;
    try {
        html = await fetchHtml(url);
    } catch (err) {
        logger.error('Flipkart scraper: search request failed', { query, message: err.message });
        throw err;
    }

    const results = parseSearchResults(html);
    logger.info('Flipkart scraper search finished', { query, count: results.length });

    return validateProviderProductList(results);
}

async function searchByLink(url) {
    let html;
    try {
        html = await fetchHtml(url);
    } catch (err) {
        logger.error('Flipkart scraper: product page request failed', { url, message: err.message });
        throw err;
    }

    const result = parseProductDetail(html, url);
    if (!result) {
        logger.warn('Flipkart scraper: could not extract product details', { url });
        return null;
    }

    logger.info('Flipkart scraper product-detail finished', { url });

    return validateProviderProduct(result);
}

module.exports = { searchByQuery, searchByLink };