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

// Fallbacks so a missing env value can never silently produce 0 results
// (results.length < undefined is always false).
const MAX_SEARCH_RESULTS = (config.scraper && config.scraper.maxSearchResults) || 10;
const TIMEOUT_MS = (config.scraper && config.scraper.timeoutMs) || 20000;
const MAX_IMAGES = (config.product && config.product.maxImages) || 10;

// ── HTTP ─────────────────────────────────────────────────────────────

// Flipkart serves a different (or blocked) page to requests that don't
// look like a real browser navigation - keep this full header set.
function getHeaders(referer) {
    return {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/124.0.6367.207 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,' +
            'image/avif,image/webp,image/apng,*/*;q=0.8,' +
            'application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': 'en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Cache-Control': 'max-age=0',
        'sec-ch-ua': '"Google Chrome";v="124","Chromium";v="124","Not-A.Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'Referer': referer || BASE,
    };
}

let cachedCookie = '';
let cookieFetchedAt = 0;

function buildAxiosOptions(cookie) {
    const opts = {
        headers: getHeaders(BASE),
        timeout: TIMEOUT_MS,
        decompress: true,
        maxRedirects: 5,
    };
    if (cookie) opts.headers.Cookie = cookie;

    // Optional: route through a proxy, e.g. FLIPKART_PROXY_URL=http://user:pass@host:port
    const proxyUrl = process.env.FLIPKART_PROXY_URL;
    if (proxyUrl) {
        const HttpsProxyAgent = require('https-proxy-agent').HttpsProxyAgent;
        opts.httpsAgent = new HttpsProxyAgent(proxyUrl);
        opts.proxy = false;
    }
    return opts;
}

// Visit the homepage once to pick up session cookies, reuse for 10 minutes.
async function warmUpCookies(force) {
    if (!force && cachedCookie && Date.now() - cookieFetchedAt < 10 * 60 * 1000) {
        return cachedCookie;
    }
    try {
        const res = await axios.get(BASE + '/', buildAxiosOptions(''));
        const setCookie = res.headers['set-cookie'] || [];
        cachedCookie = setCookie
            .map(function(c) { return c.split(';')[0]; })
            .join('; ');
        cookieFetchedAt = Date.now();
    } catch (err) {
        cachedCookie = '';
    }
    return cachedCookie;
}

function sleep(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

async function fetchHtml(url) {
    const cookie = await warmUpCookies(false);
    try {
        const response = await axios.get(url, buildAxiosOptions(cookie));
        return response.data;
    } catch (err) {
        const status = err.response ? err.response.status : null;
        if (status === 403 || status === 429 || status === 529) {
            logger.warn('Flipkart scraper: blocked, retrying once', { url, status });
            await sleep(1500 + Math.floor(Math.random() * 1000));
            const freshCookie = await warmUpCookies(true);
            const retry = await axios.get(url, buildAxiosOptions(freshCookie));
            return retry.data;
        }
        throw err;
    }
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

function extractBreadcrumb($) {
    return $('nav a, ._1MR4o5 a, [class*="breadcrumb"] a')
        .map(function() { return $(this).text().replace(/\\s+/g, ' ').trim(); })
        .get()
        .filter(function(value) { return value && value.toLowerCase() !== 'home'; });
}

// ── Search page parsing ─────────────────────────────────────────────

// Flipkart's class names are obfuscated and rotate periodically. Every
// extractor below tries the currently-known class names first, then falls
// back to stable signals (link title attr, image alt, "₹<digits>" text),
// so a class rotation degrades gracefully instead of returning 0 results.
// If results still drop to 0, the warning logged in searchByQuery shows
// whether the page was blocked or the layout changed.

// Title: list layout uses div.RG5Slk, grid layout (fashion/home) uses
// a.atJtCj whose full title is in the `title` attribute.
function extractCardTitle($, el, linkEl) {
    const gridLink = el.find('a.atJtCj').first();
    if (gridLink.length) {
        const gt = (gridLink.attr('title') || gridLink.text() || '').trim();
        if (gt) return gt;
    }

    let t = el.find('div.RG5Slk, div.KzDlHZ, div._4rR01T, a.IRpwTa, a.WKTcLC').first().text().trim();
    if (t) return t;

    t = (linkEl.attr('title') || '').trim();
    if (t) return t;

    const alt = (el.find('img').first().attr('alt') || '').trim();
    if (alt.length > 5) return alt;

    return '';
}

// Price: known class first, then the first leaf element whose text is
// exactly "₹12,345" (document order puts the current price before the
// struck-through MRP), then a regex over the card text.
function extractCardPrice($, el) {
    const known = el.find('div.hZ3P6w').first().text().replace(/[^0-9]/g, '');
    if (known) return parseFloat(known);

    let price = null;
    el.find('*').each(function(_, node) {
        const n = $(node);
        if (n.children().length > 0) return;
        const text = n.text().trim();
        if (/^₹\s?[\d,]+$/.test(text)) {
            price = parseFloat(text.replace(/[^0-9]/g, ''));
            return false;
        }
    });
    if (price !== null && !isNaN(price)) return price;

    const m = el.text().match(/₹\s?([\d,]+)/);
    if (!m) return null;
    const digits = m[1].replace(/[^0-9]/g, '');
    return digits ? parseFloat(digits) : null;
}

function extractCardImage($, el) {
    const rukmin = el.find('img[src*="rukminim"]').first().attr('src');
    if (rukmin) return rukmin;
    const any = el.find('img').first().attr('src');
    return any && any.indexOf('data:') !== 0 ? any : null;
}

function parseSearchResults(html) {
    const $ = cheerio.load(html);
    const results = [];
    const seen = {};

    const items = $('[data-id]').toArray();

    for (let i = 0; i < items.length && results.length < MAX_SEARCH_RESULTS; i++) {
        const el = $(items[i]);

        // The card's own data-id attribute IS the real pid (confirmed live -
        // matches the ?pid= query param on its own href exactly, when
        // present) - reading it directly here is more reliable than parsing
        // it back out of the href, since it doesn't depend on the href
        // happening to carry ?pid= at all. See extractPidFromUrl's comment
        // for why the href/URL should never be used to *guess* an id.
        const pid = (el.attr('data-id') || '').toUpperCase();
        if (!pid || seen[pid]) continue; // no stable identity, or duplicate card

        const linkEl = el.find('a[href*="/p/"]').first();

        const title = extractCardTitle($, el, linkEl);
        if (!title) continue;

        const price = extractCardPrice($, el);
        if (price === null || isNaN(price)) continue;

        // Clean canonical URL: path + ?pid= only (drops tracking params)
        const hrefPath = (linkEl.attr('href') || '').split('?')[0];
        const productUrl = hrefPath ? absoluteUrl(hrefPath) + '?pid=' + pid : null;
        if (!productUrl) continue;

        const image = extractCardImage($, el);

        seen[pid] = true;
        results.push(
            withDefaults({
                marketplace: 'flipkart',
                externalId: pid,
                title,
                images: image ? [image] : [],
                currentPrice: price,
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
    return (highRes.length > 0 ? highRes : collect(200)).slice(0, MAX_IMAGES);
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
    const categoryPath = extractBreadcrumb($);

    return withDefaults({
        marketplace: 'flipkart',
        externalId: pid,
        title,
        brand,
        category: categoryPath.length > 0 ? categoryPath[categoryPath.length - 1] : null,
        categoryPath,
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
    const url = BASE + '/search?q=' + encodeURIComponent(query) +
        '&otracker=search&marketplace=FLIPKART&as-show=on&as=off';

    let html;
    try {
        html = await fetchHtml(url);
    } catch (err) {
        logger.error('Flipkart scraper: search request failed', { query, message: err.message });
        throw err;
    }

    const results = parseSearchResults(html);

    // Diagnostics: tells you WHY a search came back empty.
    //  - htmlLength tiny / looksBlocked true  -> Flipkart blocked or captcha'd this IP
    //  - dataIdCount 0 on a normal-size page   -> different layout / client-rendered page
    //  - dataIdCount > 0 but count 0           -> selectors need re-inspecting
    if (results.length === 0) {
        const htmlStr = typeof html === 'string' ? html : String(html);
        logger.warn('Flipkart scraper: search parsed 0 results', {
            query,
            htmlLength: htmlStr.length,
            dataIdCount: cheerio.load(htmlStr)('[data-id]').length,
            looksBlocked: /captcha|access denied|unusual traffic/i.test(htmlStr),
        });
    }

    logger.info('Flipkart scraper search finished', { query, count: results.length });

    const validated = validateProviderProductList(results);
    if (results.length > 0 && (!validated || validated.length === 0)) {
        logger.warn('Flipkart scraper: validator dropped all parsed results', {
            query,
            parsed: results.length,
            sample: results[0],
        });
    }

    return validated;
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