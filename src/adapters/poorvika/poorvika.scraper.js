// src/adapters/poorvika/poorvika.scraper.js
//
// Scraper-only Poorvika adapter - no official API exists, so this is
// the sole implementation (poorvika/index.js just re-exports it), same
// reasoning as adapters/lenskart and adapters/myntra.
//
// Ported from the fixture-backed research in
// src/scraper/src/connectors/poorvika/ (a separate, standalone project
// in this repo - see that connector's parse.ts/selectors.ts for the
// full evidence trail this was verified against):
//   - Search results page is "/{query}/s?q={query}" (note: spaces in
//     the path segment are joined with "+", not "%20" - the "%20" form
//     redirects to this one) and is plain server-rendered HTML.
//   - Product pages carry title/brand/images/description/price in a
//     JSON-LD "Product" block, but that block's price is a schema.org
//     AggregateOffer (lowPrice/highPrice + a nested offers[] array) -
//     the REAL selling price is offers.offers[0].price, never
//     lowPrice/highPrice directly. MRP is offers.highPrice, but only
//     when it's genuinely greater than the selling price.
//   - offers.offers[0].itemOffered.name is the clean product title;
//     the top-level Product.name is SEO marketing copy on this site
//     ("Unlock the Apple iPhone 16 ... and Secure Best Price"), so the
//     nested name is preferred and the top-level one is only a
//     fallback.
//   - No reliable stock-status signal exists anywhere in the static
//     HTML (JSON-LD claims "In Stock" even on a confirmed
//     out-of-stock page) - availability is honestly reported as
//     'unknown' rather than guessed.

'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const logger = require('../../utils/logger');
const { withDefaults, validateProviderProduct, validateProviderProductList } = require('../provider.interface');

const BASE = 'https://www.poorvika.com';
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

// ── Helpers ──────────────────────────────────────────────────────────

function toNum(val) {
    if (val === null || val === undefined) return null;
    const n = parseFloat(String(val).replace(/[^0-9.]/g, ''));
    return Number.isNaN(n) ? null : n;
}

function cleanText(str) {
    return (str || '').replace(/\s+/g, ' ').trim() || null;
}

// Search-card price elements on this site have been observed with a
// rating badge glued directly onto the price text with no separator at
// all (e.g. "Pre Book : ₹ 1,69,9905(1)" - the "5(1)" is a 5-star/1-review
// badge, not part of the price). A greedy [\d,]+ match still swallows
// that glued digit ("1,69,9905"), so this instead requires the FIXED
// Indian digit-grouping shape - a leading 1-2 digit group, zero or more
// 2-digit groups, then exactly one final 3-digit group - and stops
// there, leaving any glued digits unconsumed.
//
// The middle "2-digit group" is `(?:,\d{2})*` - ZERO or more, not one
// or more. A first cut of this used "+" (one or more), which silently
// broke every 4- and 5-digit Indian-grouped price (e.g. "1,199" or
// "12,199" - Indian grouping only inserts a comma every 2 digits AFTER
// the first 3, so these have no middle group at all, just the leading
// digits + one comma + the final 3). With "+" those never matched the
// grouped branch, fell through to the "short" fallback below, and that
// fallback's own negative-lookahead stopped at the FIRST digit before
// the comma (nothing after "1" in "1,199" is a digit) - silently
// reporting a ₹1,199 laptop stand as ₹1. "*" (zero-or-more) matches
// that shape too while still stopping cleanly before a glued digit,
// via the same backtracking Vijay Sales' own fixed-width matching
// relies on.
function extractRupeeAmount(text) {
    if (!text) return null;

    const grouped = /₹\s*(\d{1,2}(?:,\d{2})*,\d{3}(?:\.\d{1,2})?)/.exec(text);
    if (grouped) return toNum(grouped[1]);

    // No comma at all - only valid for genuinely sub-1000 prices
    // (Indian grouping always inserts a comma from 1,000 up), so a
    // ≤3-digit match here is never mistaken for the front of a larger
    // number.
    const short = /₹\s*(\d{1,3}(?:\.\d{1,2})?)(?!\d)/.exec(text);
    if (short) return toNum(short[1]);

    return toNum(text); // no rupee symbol present - fall back to the old behavior
}

// Real bug found live: parseSearchResults used the URL slug as
// externalId (the only identity signal a search-results CARD carries -
// the product's real `sku` isn't rendered there at all), while
// parseProductPage used product.sku from the detail page's own JSON-LD -
// two completely unrelated values for the exact same real product.
// Product documents are deduplicated on (marketplace, externalId), so
// every Poorvika product first found via search and later refreshed via
// searchByLink (compare-url, or the price-refresher job) got a BRAND NEW
// duplicate document instead of an in-place update - confirmed live (a
// "Zebronics ZEB-NS1500 laptop stand" ended up as two documents, same
// rawUrl, externalId "Zeb-NS1500" vs "zebronics-zeb-ns1500-laptop-stand-
// black"). Both paths now derive externalId from the URL slug instead -
// the one identity signal genuinely available (and equal) in both
// places. product.sku is still captured, just as the separate `sku`
// display field, not identity - see flipkart.scraper.js's
// extractPidFromHtml/extractPidFromUrl comments for the sibling bug this
// same pattern caused there.
function extractSlugFromUrl(url) {
    if (!url) return null;
    try {
        const pathname = new URL(url).pathname;
        return pathname.replace(/^\/|\/p$/g, '') || null;
    } catch (err) {
        return null;
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

function isRecord(val) {
    return val !== null && typeof val === 'object';
}

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

// Root-first, excluding only the site root ("Home") - the leaf on this
// site IS a real category (unlike Vijay Sales, whose leaf is the
// product's own name), so it is kept.
function categoryPathFromBreadcrumb(breadcrumb) {
    const items = (breadcrumb && breadcrumb.itemListElement) || [];
    if (items.length <= 1) return [];
    return items
        .slice(1) // drop the site root ("Home")
        .map(function(item) {
            return cleanText((item && item.item && item.item.name) || (item && item.name));
        })
        .filter(Boolean);
}

function categoryFromBreadcrumb(breadcrumb) {
    const path = categoryPathFromBreadcrumb(breadcrumb);
    return path.length > 0 ? path[path.length - 1] : null;
}

function imagesFromJsonLd(image) {
    if (typeof image === 'string') return [image];
    if (Array.isArray(image)) return image.filter(function(i) { return typeof i === 'string'; });
    return [];
}

// The literal string "undefined" has been observed as Poorvika's own
// server-rendered description on at least one real product (their
// backend stringifying a missing value) - treated the same as absent.
function descriptionOrNull(value) {
    if (!value || value === 'undefined') return null;
    return value;
}

function resolveTitle(product) {
    const nested = product.offers && product.offers.offers && product.offers.offers[0] &&
        product.offers.offers[0].itemOffered && product.offers.offers[0].itemOffered.name;
    if (nested) return cleanText(nested);
    return cleanText(product.name);
}

function resolvePrice(offers) {
    const concreteOffer = offers && offers.offers && offers.offers[0];
    if (!concreteOffer || concreteOffer.price === undefined) return null;
    return toNum(concreteOffer.price);
}

function resolveMrp(offers, price) {
    if (!offers || offers.highPrice === undefined) return null;
    const highPrice = toNum(offers.highPrice);
    if (highPrice === null || highPrice <= price) return null;
    return highPrice;
}

// ── Search page parsing ─────────────────────────────────────────────

// Walks up from the title anchor to find the enclosing card - NOT just
// the nearest ancestor <div> (anchor.closest('div')), which lands on a
// "description" sub-div holding only the title/price and no image at
// all (confirmed against real markup: the thumbnail <img> is a sibling
// one level further up, in a wider card wrapper). CSS-module class
// names on this site carry a build-specific hash suffix
// ("...__eduH5", "...__IeCc4") that changes across deploys, so this
// walks up looking for the first ancestor that actually CONTAINS an
// <img> - a structural signal, not a class name - rather than hardcode
// a hash that will go stale. Bounded to 6 levels so a page with no
// image anywhere nearby doesn't walk all the way to <body>.
function findCardWithImage($, anchor) {
    let node = anchor;
    for (let i = 0; i < 6; i++) {
        node = node.parent();
        if (!node || node.length === 0) break;
        if (node.find('img').length > 0) return node;
    }
    return anchor.closest('li, div'); // no image found nearby - fall back to the title/price container
}

// Poorvika renders each result card with two anchors to the same
// product URL; this targets the one wrapping the title text
// (`<a target="_blank" href="/<slug>/p"><b>Title</b>`), then walks up
// to the card container to pull a nearby displayed price and image -
// the search endpoint's own markup carries no price *scope* metadata,
// but a raw rupee figure is genuinely present on the card and is good
// enough for a search-results listing.
function parseSearchResults(html) {
    const $ = cheerio.load(html);
    const results = [];
    const seen = {};

    $('a[href$="/p"]').each(function(_, el) {
        if (results.length >= MAX_SEARCH_RESULTS) return;

        const anchor = $(el);
        const title = cleanText(anchor.find('b').first().text()) || cleanText(anchor.text());
        if (!title) return;

        const href = anchor.attr('href');
        if (!href) return;
        const slug = href.replace(/^\/|\/p$/g, '');
        if (!slug || seen[slug]) return;

        const card = findCardWithImage($, anchor);
        const currentPrice = extractRupeeAmount(card.find('[class*="price"]').first().text());
        if (currentPrice === null) return;

        seen[slug] = true;

        const image = card.find('img').first().attr('src') || card.find('img').first().attr('data-src') || null;

        results.push(
            withDefaults({
                marketplace: 'poorvika',
                externalId: slug,
                title,
                images: image ? [image] : [],
                currentPrice,
                originalPrice: extractRupeeAmount(card.find('[class*="price"][class*="old"], del, s').first().text()),
                currency: 'INR',
                availability: 'unknown',
                rawUrl: BASE + href,
                keywords: buildKeywords(title),
                fetchedVia: 'scraper',
            })
        );
    });

    return results;
}

// ── Product page parsing ─────────────────────────────────────────────

// Real gap found live: search results never carried a category, because
// the search-results page's cards carry no breadcrumb/category signal
// AT ALL in their markup (only title/price/image) - unlike Vijay Sales,
// where the data was already sitting in the search response being
// parsed, there is genuinely no free source here. category IS available
// on each product's own detail page (categoryFromBreadcrumb, already
// used by parseProductPage below) - so getting it for search results
// means fetching each result's own product page, same tradeoff Nykaa's
// searchByQuery already accepts for its own reason (that site's search
// endpoint carries no price at all). Isolated into its own lightweight
// function (not a full parseProductPage call) since search enrichment
// only needs the category, not re-validating price/sku/title too.
function extractCategoryFromHtml(html) {
    const jsonLdValues = extractJsonLdValues(html);
    const breadcrumb = findJsonLdByType(jsonLdValues, 'BreadcrumbList');
    return { category: categoryFromBreadcrumb(breadcrumb), categoryPath: categoryPathFromBreadcrumb(breadcrumb) };
}

function parseProductPage(html, url) {
    const jsonLdValues = extractJsonLdValues(html);
    const product = findJsonLdByType(jsonLdValues, 'Product');
    if (!product || !product.sku || !product.name) return null;

    const price = resolvePrice(product.offers);
    if (price === null) return null;

    const mrp = resolveMrp(product.offers, price);
    const breadcrumb = findJsonLdByType(jsonLdValues, 'BreadcrumbList');
    const title = resolveTitle(product);
    if (!title) return null;

    // Identity comes from the URL slug, matching parseSearchResults - see
    // extractSlugFromUrl's own comment for why product.sku can't be used
    // here despite being the more "official"-looking value.
    const slug = extractSlugFromUrl(url);
    if (!slug) return null;

    const currency = (
        (product.offers && product.offers.offers && product.offers.offers[0] && product.offers.offers[0].priceCurrency) ||
        (product.offers && product.offers.priceCurrency) ||
        'INR'
    ).toUpperCase();

    return withDefaults({
        marketplace: 'poorvika',
        externalId: slug,
        sku: String(product.sku),
        title,
        brand: cleanText(product.brand && product.brand.name),
        category: categoryFromBreadcrumb(breadcrumb),
        categoryPath: categoryPathFromBreadcrumb(breadcrumb),
        images: imagesFromJsonLd(product.image).slice(0, 10),
        currentPrice: price,
        originalPrice: mrp,
        currency,
        // Confirmed dead end on this site's static HTML - JSON-LD's own
        // availability claim has been observed wrong on a confirmed
        // out-of-stock product, and no other static signal was found to
        // differ by stock state. 'unknown' is the honest value, not a
        // guess of 'in_stock'.
        availability: 'unknown',
        rawUrl: url,
        keywords: buildKeywords(title),
        metadata: { description: descriptionOrNull(product.description) },
        fetchedVia: 'scraper',
    });
}

// ── Public contract ─────────────────────────────────────────────────

// Enriches each search result with a category by fetching its own
// product page - see extractCategoryFromHtml's comment for why this is
// necessary (the search page's cards carry no category signal at all).
// Best-effort and parallel (Promise.allSettled): one result's page
// failing to fetch/parse must not fail the whole search, and just
// leaves that one result's category null rather than dropping it
// entirely - a missing category is a lesser degradation than a missing
// product.
async function enrichWithCategories(results) {
    const settled = await Promise.allSettled(
        results.map(function(product) {
            return fetchHtml(product.rawUrl, BASE + '/').then(function(detailHtml) {
                return extractCategoryFromHtml(detailHtml);
            });
        })
    );

    return results.map(function(product, i) {
        const outcome = settled[i];
        if (outcome.status !== 'fulfilled') return product;
        return Object.assign({}, product, outcome.value);
    });
}

async function searchByQuery(query) {
    const pathSegment = encodeURIComponent(query).replace(/%20/g, '+');
    const url = BASE + '/' + pathSegment + '/s?q=' + encodeURIComponent(query);

    let html;
    try {
        html = await fetchHtml(url, BASE);
    } catch (err) {
        logger.error('Poorvika scraper: search request failed', { query, message: err.message });
        throw err;
    }

    const cardResults = parseSearchResults(html);
    const results = await enrichWithCategories(cardResults);
    logger.info('Poorvika scraper search finished', { query, count: results.length });

    return validateProviderProductList(results);
}

async function searchByLink(url) {
    let html;
    try {
        html = await fetchHtml(url, BASE + '/');
    } catch (err) {
        logger.error('Poorvika scraper: product page request failed', { url, message: err.message });
        throw err;
    }

    const result = parseProductPage(html, url);
    if (!result) {
        logger.warn('Poorvika scraper: could not extract product details', { url });
        return null;
    }

    logger.info('Poorvika scraper product-detail finished', { url });

    return validateProviderProduct(result);
}

module.exports = { searchByQuery, searchByLink };
