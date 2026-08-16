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
const config = require('../../config/env');
const { withDefaults, validateProviderProduct, validateProviderProductList } = require('../provider.interface');

const BASE = 'https://www.flipkart.com';
const MAX_SEARCH_RESULTS = config.scraper.maxSearchResults;

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
        timeout: config.scraper.timeoutMs,
    });
    return response.data;
}

// ── Helpers ──────────────────────────────────────────────────────────

// Real bug found live: this used to fall back to matching the `/p/<id>`
// PATH segment (e.g. "itmee33cb4f8c0b2") when a URL had no `?pid=` query
// param, and treated that as the pid. It isn't - Flipkart's `itm...` path
// segment is a SEPARATE identifier (an item id) from the real pid (e.g.
// "ACCG6DS7WDJHGWSH"), confirmed by fetching a real product page: its
// canonical URL has no ?pid= at all, yet the page's own embedded JSON
// carries the true pid, which does NOT match the uppercased itm-id. Since
// Product documents are deduplicated on (marketplace, externalId), that
// wrong fallback silently created a DUPLICATE document (keyed off the
// fabricated itm-id) every time searchByLink refreshed a product whose
// stored rawUrl happened to lack ?pid= - instead of updating the existing
// one. Two real products in the live DB were affected this way. Query-param
// extraction is still correct and cheap, so it stays as the fast path;
// parseProductDetail additionally reads the real pid straight out of the
// fetched page (extractPidFromHtml below) for when it's absent from the
// URL - that never fabricates a wrong id, it just returns null instead.
function extractPidFromUrl(url) {
    const queryMatch = url.match(/[?&]pid=([A-Z0-9]+)/i);
    if (queryMatch) return queryMatch[1].toUpperCase();
    return null;
}

// Product-detail pages embed the real pid in an inline JSON blob as
// "pid":"<ID>" regardless of whether the page's own URL carries a ?pid=
// query param - this is the authoritative source for parseProductDetail,
// verified against a real page whose canonical URL had no ?pid= at all.
function extractPidFromHtml(html) {
    const m = html.match(/"pid"\s*:\s*"([A-Z0-9]+)"/i);
    return m ? m[1].toUpperCase() : null;
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

        // The card's own data-id attribute IS the real pid (confirmed live -
        // matches the ?pid= query param on its own href exactly, when
        // present) - reading it directly here is more reliable than parsing
        // it back out of the href, since it doesn't depend on the href
        // happening to carry ?pid= at all. See extractPidFromUrl's comment
        // for why the href/URL should never be used to *guess* an id.
        const pid = (el.attr('data-id') || '').toUpperCase() || null;
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

// Real bug found live: this function never extracted images at all,
// which meant every product refreshed through it (compare-url's
// "original" product, and - worse - the price-refresher job
// re-upserting an EXISTING product) silently WIPED that product's
// images back to [] on every refresh, even if a prior search had
// already found real ones (upsertFromProviderData overwrites `images`
// unconditionally with whatever this function returns - confirmed 10
// real Flipkart products in the live DB already had their images
// erased this way before this fix).
//
// Flipkart's real product-detail page embeds the gallery as plain
// rukminim*.flixcart.com <img> tags with NO stable class name to key
// off (Flipkart's classes are obfuscated/rotate periodically - same
// caveat parseSearchResults' own comment already makes) - the one
// stable signal is the URL shape itself: /image/<width>/<height>/...,
// confirmed this product's own high-res gallery renders at width=800,
// while thumbnails/nav dots reuse the SAME photo at width=80 and
// unrelated "similar products"/promo images live under a different
// path entirely (/www/.../promos/, /prod-fk-cms-brand-images/) or a
// smaller width tier. Preferring width>=700 and only falling back to
// width>=200 if a page genuinely has none of those is what keeps this
// from pulling in a "frequently bought together" carousel's photos -
// verified against two different real product pages (a phone and a
// laptop): the width>=700 result matched exactly what searchByQuery
// already returns for that same product.
function extractGalleryImages($) {
    function collect(minWidth) {
        const seen = {};
        const images = [];
        $('img').each(function(_, el) {
            const src = $(el).attr('src');
            if (!src) return;
            if (/cms-brand-images|\/promos\//.test(src)) return; // seller/brand badges, not product photos
            const m = src.match(/rukminim\d*\.flixcart\.com\/image\/(\d+)\/(\d+)\//);
            if (!m) return;
            const width = parseInt(m[1], 10);
            if (width < minWidth) return;
            // Thumbnails are the SAME photo re-served at a smaller size -
            // same hash-looking filename segment, different /W/H/ prefix -
            // so dedupe on that filename, not the full URL.
            const keyMatch = src.match(/\/([a-z0-9]{10,})\.(jpeg|jpg|png)/i);
            const key = keyMatch ? keyMatch[1] : src;
            if (seen[key]) return;
            seen[key] = true;
            images.push(src);
        });
        return images;
    }

    const highRes = collect(700);
    return (highRes.length > 0 ? highRes : collect(200)).slice(0, config.product.maxImages);
}

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

    // Prefer the pid embedded in the page itself (authoritative, present
    // even when the URL has no ?pid=) - only fall back to the URL's query
    // param if the page's own markup didn't have it for some reason.
    const pid = extractPidFromHtml(html) || extractPidFromUrl(productUrl);
    if (!pid) return null;

    const brand = title.split(' ')[0];

    return withDefaults({
        marketplace: 'flipkart',
        externalId: pid,
        title,
        brand,
        images: extractGalleryImages($),
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