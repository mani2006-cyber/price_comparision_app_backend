// src/jobs/priceRefresher.job.js
//
// Scheduled job: finds stale products, re-fetches each via its stored
// rawUrl, re-upserts (which handles price-change detection + PriceHistory
// recording automatically via product.repository.js), and checks alerts
// for any product whose price changed. Processes products SEQUENTIALLY
// with a delay between each - a background job has no urgency, and
// concurrent requests here risk getting the whole app rate-limited by a
// marketplace, hurting every user's live searches, not just this job.

'use strict';

const cron = require('node-cron');
const config = require('../config/env');
const logger = require('../utils/logger');
const adapters = require('../adapters');
const productRepository = require('../repositories/product.repository');
const alertService = require('../services/alert.service');

// Safety valve - bounds how many products a single run processes, so a
// job that's fallen behind (was down, or the catalog grew large)
// processes a bounded batch per run instead of potentially running for
// hours and overlapping its own next scheduled tick.
const BATCH_LIMIT = 100;

// Products not checked in this long are considered "stale" and eligible
// for refresh. Matches the cadence implied by PRICE_REFRESHER_CRON
// (default: every 6 hours) - no point re-checking something we just
// looked at moments ago via a live user search.
const STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000;

function delay(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

async function refreshOne(product) {
    const providerProduct = await adapters.searchByLink(product.rawUrl);

    if (!providerProduct) {
        logger.warn('Price refresher: could not re-fetch product, skipping', {
            productId: product._id.toString(),
            marketplace: product.marketplace,
            rawUrl: product.rawUrl,
        });
        return;
    }

    const outcome = await productRepository.upsertFromProviderData(providerProduct);

    if (outcome.priceChanged) {
        logger.info('Price refresher: price changed', {
            productId: outcome.product._id.toString(),
            oldCheckedAt: product.lastCheckedAt,
            newPrice: outcome.product.currentPrice,
        });

        await alertService.checkAndTriggerAlerts(
            outcome.product._id,
            outcome.product.currentPrice,
            outcome.product.title
        );
    }
}

// ── The actual logic - independently callable/testable without waiting
// for a real cron tick ─────────────────────────────────────────────
async function runOnce() {
    const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS);
    const staleProducts = await productRepository.findStale(staleThreshold, BATCH_LIMIT);

    logger.info('Price refresher run started', { staleCount: staleProducts.length });

    let succeeded = 0;
    let failed = 0;

    for (let i = 0; i < staleProducts.length; i++) {
        try {
            await refreshOne(staleProducts[i]);
            succeeded++;
        } catch (err) {
            failed++;
            logger.error('Price refresher: failed to refresh a product', {
                productId: staleProducts[i]._id.toString(),
                message: err.message,
            });
        }

        // Deliberate delay between items - see file header comment.
        if (i < staleProducts.length - 1) {
            await delay(config.priceRefresher.delayMs);
        }
    }

    logger.info('Price refresher run completed', {
        total: staleProducts.length,
        succeeded,
        failed,
    });

    return { total: staleProducts.length, succeeded, failed };
}

// ── Wires runOnce to the configured cron schedule. Called explicitly by
// server.js - this file does not self-start on require() ─────────────
function start() {
    cron.schedule(config.priceRefresher.cronSchedule, function() {
        runOnce().catch(function(err) {
            // runOnce already catches per-product errors internally - this
            // only fires for something catastrophic (e.g. the findStale query
            // itself failing), which is worth logging distinctly from a
            // normal per-item failure.
            logger.error('Price refresher run crashed unexpectedly', err);
        });
    });

    logger.info('Price refresher job scheduled', { cronSchedule: config.priceRefresher.cronSchedule });
}

module.exports = { start, runOnce };