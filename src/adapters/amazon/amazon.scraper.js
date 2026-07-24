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

// ── Retry configuration ─────────────────────────────────────────────
const MAX_RETRIES = 4; // total attempts = MAX_RETRIES + 1
const BASE_DELAY_MS = 1000; // first retry waits ~1s
const MAX_DELAY_MS = 15000; // cap backoff at 15s

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Circuit breaker ──────────────────────────────────────────────────
// If Amazon is sustaining a block (not just a transient blip), retrying
// every single call wastes time and makes the block worse. After enough
// consecutive full-retry failures, short-circuit for a cooldown window
// so callers (e.g. the auto-mode orchestrator) can fail fast to another
// provider instead of waiting ~13s per request for a doomed retry chain.
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

let consecutiveFailures = 0;
let circuitOpenUntil = 0;

function circuitIsOpen() {
    return Date.now() < circuitOpenUntil;
}

function recordFailure() {
    consecutiveFailures++;
    if (consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
        circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
        logger.error('Amazon scraper: circuit breaker OPEN, pausing scraper calls', {
            consecutiveFailures,
            cooldownMs: CIRCUIT_COOLDOWN_MS,
        });
    }
}

function recordSuccess() {
    consecutiveFailures = 0;
    circuitOpenUntil = 0;
}

// Exponential backoff with jitter, e.g. attempt 0 -> ~1s, 1 -> ~2s, 2 -> ~4s, 3 -> ~8s (capped)
function backoffDelay(attempt) {
    const exp = BASE_DELAY_MS * Math.pow(2, attempt);
    const jitter = Math.random() * 500;
    return Math.min(exp + jitter, MAX_DELAY_MS);
}

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

// Fetches a URL, retrying on 503 (and on network/5xx errors) with a sleep-based
// exponential backoff. Honors the Retry-After header when Amazon sends one.
async function fetchHtml(url, referer) {
    if (circuitIsOpen()) {
        const waitMs = circuitOpenUntil - Date.now();
        throw new Error(
            'Amazon scraper: circuit breaker open (cooling down for ' +
            Math.ceil(waitMs / 1000) + 's more) - skipping request to ' + url
        );
    }

    let lastErr;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const response = await axios.get(url, {
                headers: getHeaders(referer),
                timeout: 20000,
                decompress: true,
                maxRedirects: 5,
                // Let us inspect 503s ourselves instead of axios throwing immediately
                validateStatus: (status) => status === 200 || status === 503,
            });

            if (response.status === 200) {
                recordSuccess();
                return response.data;
            }

            // status === 503 here - check whether this is really a bot-block/captcha
            // page rather than a transient "server busy" response. If so, retrying
            // harder won't help; log it once so it's diagnosable.
            const bodySnippet = String(response.data || '').slice(0, 300);
            const looksLikeBotBlock = /captcha|Robot Check|automated access|unusual traffic/i.test(bodySnippet);

            if (attempt === MAX_RETRIES) {
                logger.error('Amazon scraper: 503 response body preview', { url, bodySnippet, looksLikeBotBlock });
                recordFailure();
                throw new Error('Amazon returned 503 after ' + (MAX_RETRIES + 1) + ' attempts: ' + url);
            }

            if (looksLikeBotBlock) {
                logger.warn('Amazon scraper: 503 looks like a bot-detection page, not transient load', {
                    url,
                    bodySnippet,
                });
            }

            const retryAfterHeader = response.headers && response.headers['retry-after'];
            const delay = retryAfterHeader ?
                parseInt(retryAfterHeader, 10) * 1000 :
                backoffDelay(attempt);

            logger.warn('Amazon scraper: got 503, retrying after sleep', {
                url,
                attempt: attempt + 1,
                maxAttempts: MAX_RETRIES + 1,
                delayMs: delay,
            });

            await sleep(delay);
            continue;

        } catch (err) {
            lastErr = err;

            // Network-level errors (timeout, DNS, connection reset, etc.) - retry these too
            const isLastAttempt = attempt === MAX_RETRIES;
            const status = err.response && err.response.status;

            if (isLastAttempt) {
                logger.error('Amazon scraper: request failed, giving up', {
                    url,
                    attempt: attempt + 1,
                    status: status || null,
                    message: err.message,
                });
                throw err;
            }

            const delay = backoffDelay(attempt);
            logger.warn('Amazon scraper: request error, retrying after sleep', {
                url,
                attempt: attempt + 1,
                status: status || null,
                message: err.message,
                delayMs: delay,
            });
            await sleep(delay);
        }
    }

    // Should not be reached, but keep a safety net
    throw lastErr || new Error('Amazon scraper: fetchHtml failed for unknown reason: ' + url);
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