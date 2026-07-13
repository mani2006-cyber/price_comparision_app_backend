// src/services/alert.service.js
//
// Business logic for price alerts. Wraps alert.repository.js +
// notification.repository.js. checkAndTriggerAlerts is the function the
// price-refresher job calls after every price update - it is the actual
// "did anything just become alert-worthy" decision point for the whole app.

'use strict';

const ApiError = require('../utils/ApiError');
const alertRepository = require('../repositories/alert.repository');
const productRepository = require('../repositories/product.repository');
const notificationRepository = require('../repositories/notification.repository');
const logger = require('../utils/logger');

// ── Create ───────────────────────────────────────────────────────────
async function createAlert(userId, productId, targetPrice) {
    const product = await productRepository.findById(productId);
    if (!product) {
        throw ApiError.notFound('Product not found');
    }

    // Business rule (not a model-level constraint - see file header
    // comment): a target at or above the current price would fire
    // immediately on the next check, which isn't what "notify me when it
    // drops" means. Model stays agnostic about this; it's product policy.
    if (targetPrice >= product.currentPrice) {
        throw ApiError.badRequest(
            'Target price must be lower than the current price (₹' + product.currentPrice + ')'
        );
    }

    return alertRepository.create(userId, productId, targetPrice);
}

// ── Read ─────────────────────────────────────────────────────────────
async function getUserAlerts(userId) {
    return alertRepository.findByUser(userId);
}

// ── Cancel ───────────────────────────────────────────────────────────
async function cancelAlert(alertId, userId) {
    const result = await alertRepository.cancelByIdForUser(alertId, userId);
    if (!result) {
        // cancelByIdForUser's filter already requires status: 'active', so
        // this also correctly covers "already triggered/cancelled" as a 404,
        // not just "doesn't exist" - both are "nothing to cancel" from the
        // caller's perspective.
        throw ApiError.notFound('Active alert not found');
    }
    return result;
}

// ── Trigger check - called by the price-refresher job ────────────────
//
// Given a product that just had a price update, finds every active
// alert whose target has now been met, marks each triggered, and
// creates a notification for it. Returns the list of triggered alerts
// so the caller can log/report on what fired. One alert's failure does
// not block the others.
async function checkAndTriggerAlerts(productId, currentPrice, productTitle) {
    const metAlerts = await alertRepository.findActiveByProduct(productId, currentPrice);

    if (metAlerts.length === 0) {
        return [];
    }

    const outcomes = await Promise.allSettled(
        metAlerts.map(async function(alert) {
            const triggered = await alertRepository.markTriggered(alert._id, currentPrice);

            // markTriggered is idempotent (File 20) - if another concurrent
            // check already triggered this exact alert, it returns null here.
            // Skip notification creation in that case rather than double-notify.
            if (!triggered) {
                return null;
            }

            await notificationRepository.createForAlertTrigger(
                alert.userId,
                alert._id,
                productTitle,
                currentPrice
            );

            return triggered;
        })
    );

    const triggeredAlerts = [];
    outcomes.forEach(function(outcome, index) {
        if (outcome.status === 'fulfilled' && outcome.value) {
            triggeredAlerts.push(outcome.value);
        } else if (outcome.status === 'rejected') {
            logger.error('Failed to process a triggered alert', {
                alertId: metAlerts[index]._id.toString(),
                message: outcome.reason.message,
            });
        }
    });

    logger.info('Alert check completed', {
        productId: productId.toString(),
        currentPrice,
        metCount: metAlerts.length,
        triggeredCount: triggeredAlerts.length,
    });

    return triggeredAlerts;
}

module.exports = {
    createAlert,
    getUserAlerts,
    cancelAlert,
    checkAndTriggerAlerts,
};