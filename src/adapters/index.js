// src/adapters/index.js
//
// Single registry mapping a marketplace name to its adapter module. This
// is the ONLY file the service layer imports for provider access -
// services never require a marketplace's adapter folder directly.
// searchAllMarketplaces() is what lets a search run across every active
// marketplace without a hardcoded if/else chain - adding or removing a
// marketplace is a one-line change to MARKETPLACE_REGISTRY below.

'use strict';

const logger = require('../utils/logger');
const ApiError = require('../utils/ApiError');

const amazon = require('./amazon'); // ← back to the orchestrator, not amazon.api directly
const flipkart = require('./flipkart');
const myntra = require('./myntra');
const lenskart = require('./lenskart');
const nykaa = require('./nykaa');
const poorvika = require('./poorvika');
const vijaysales = require('./vijaysales');

// The single source of truth for which marketplaces are active. Ajio is
// deliberately absent (no scraper was built for it) - nothing else in
// this file or its callers needs to know that; it simply isn't here.
const MARKETPLACE_REGISTRY = {
    amazon,
    flipkart,
    myntra,
    lenskart,
    nykaa,
    poorvika,
    vijaysales,
};

function getActiveMarketplaces() {
    return Object.keys(MARKETPLACE_REGISTRY);
}

function getAdapter(marketplace) {
    const adapter = MARKETPLACE_REGISTRY[marketplace];

    if (!adapter) {
        throw ApiError.badRequest(
            'Unknown marketplace: ' + marketplace +
            '. Active marketplaces: ' + getActiveMarketplaces().join(', ')
        );
    }
    return adapter;
}

// ── Cross-marketplace search ────────────────────────────────────────
//
// Runs searchByQuery across every active marketplace IN PARALLEL, using
// Promise.allSettled (not Promise.all) so one marketplace failing does
// not discard results from the others. Returns:
//   {
//     results: [ ...all successful ProviderProduct results, flattened ],
//     failures: [ { marketplace, message } ]  // marketplaces that errored
//   }
async function searchAllMarketplaces(query, options) {
    const marketplaces = getActiveMarketplaces();

    const settled = await Promise.allSettled(
        marketplaces.map(function(marketplace) {
            const start = Date.now();
            return MARKETPLACE_REGISTRY[marketplace]
                .searchByQuery(query, options)
                .then(function(results) {
                    logger.debug('Marketplace search completed', {
                        marketplace,
                        query,
                        count: results.length,
                        durationMs: Date.now() - start,
                    });
                    return { marketplace, results };
                });
        })
    );

    const results = [];
    const failures = [];

    settled.forEach(function(outcome, index) {
        const marketplace = marketplaces[index];

        if (outcome.status === 'fulfilled') {
            results.push.apply(results, outcome.value.results);
        } else {
            logger.warn('Marketplace search failed, excluded from results', {
                marketplace,
                query,
                message: outcome.reason.message,
            });
            failures.push({ marketplace, message: outcome.reason.message });
        }
    });

    return { results, failures };
}

// ── Single-marketplace product lookup (for compare-url) ────────────
//
// Detects which marketplace a URL belongs to (simple hostname match)
// and delegates to that adapter's searchByLink. Used by the compare
// service to fetch the "original" product before finding cross-
// marketplace matches.
function detectMarketplaceFromUrl(url) {
    if (!url) return null;
    const lower = url.toLowerCase();

    if (lower.indexOf('amazon.') !== -1) return 'amazon';
    if (lower.indexOf('flipkart.') !== -1) return 'flipkart';
    if (lower.indexOf('myntra.') !== -1) return 'myntra';
    if (lower.indexOf('lenskart.') !== -1) return 'lenskart';
    if (lower.indexOf('nykaa.') !== -1) return 'nykaa';
    if (lower.indexOf('poorvika.') !== -1) return 'poorvika';
    if (lower.indexOf('vijaysales.') !== -1) return 'vijaysales';

    return null;
}

async function searchByLink(url) {
    const marketplace = detectMarketplaceFromUrl(url);
    if (!marketplace) {
        throw ApiError.badRequest('Could not detect a supported marketplace from this URL: ' + url);
    }

    const adapter = getAdapter(marketplace);
    return adapter.searchByLink(url);
}

module.exports = {
    getAdapter,
    getActiveMarketplaces,
    searchAllMarketplaces,
    searchByLink,
    detectMarketplaceFromUrl,
};