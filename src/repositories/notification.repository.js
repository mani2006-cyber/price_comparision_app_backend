// src/repositories/notification.repository.js
//
// All direct Mongoose access for the Notification collection.
// createForAlertTrigger is the purpose-built creation path for the one
// producer we already know about (Alert firing) - it owns the message
// formatting so that logic lives in exactly one place. Deliberately no
// generic updateById: once created, only isRead should ever change.
//
// This file is also the ONE place that calls notificationBus.publish()
// and invalidates the cached inbox (cache.del) - both happen here,
// after every successful write, rather than in notification.service.js
// or callers like alert.service.js. That's deliberate: alert.service.js
// already calls createForAlertTrigger() directly, bypassing
// notification.service.js entirely, so the service layer is NOT
// actually a single choke point every notification passes through -
// this repository is. Putting the push/invalidation here means no
// future caller can create a notification without also triggering
// both, structurally, not by remembering to.

'use strict';

const Notification = require('../models/Notification.model');
const notificationBus = require('../realtime/notificationBus');
const cache = require('../utils/cache');

// Matches EXACTLY what notification.routes.js's cacheResponse keyBuilder
// produces (keyPrefix 'notifications' + ':' + userId) - see that file's
// notificationCache definition. Kept in sync manually since the two
// files have no natural shared import point; if the route's key shape
// ever changes, this must change with it or invalidation silently stops
// working.
function inboxCacheKey(userId) {
    return 'notifications:' + userId;
}

// Best-effort, fire-and-forget - same posture as every other cache
// call in this app (src/utils/cache.js's own header comment: "never
// throws, never delays the caller"). A failed invalidation just means
// the stale cached inbox expires naturally at its TTL instead of being
// cleared early - never worth failing a notification write over.
function invalidateInboxCache(userId) {
    Promise.resolve(cache.del(inboxCacheKey(userId))).catch(function() {});
}

// ── Create ───────────────────────────────────────────────────────────

// Purpose-built for the price-refresher job: builds a consistent
// title/message/data shape whenever an Alert's target price is met.
async function createForAlertTrigger(userId, alertId, productTitle, price) {
    const notification = await Notification.create({
        userId,
        alertId,
        type: 'price_drop',
        title: 'Price dropped!',
        message: productTitle + ' dropped to ' + '₹' + price,
        data: { alertId, price },
    });

    invalidateInboxCache(userId);
    notificationBus.publish(userId, notification);

    return notification;
}

// Generic creation path for future notification types (system messages,
// back-in-stock, etc.) that aren't alert-driven.
async function create(userId, type, title, message, data) {
    const notification = await Notification.create({
        userId,
        type,
        title,
        message,
        data: data || {},
    });

    invalidateInboxCache(userId);
    notificationBus.publish(userId, notification);

    return notification;
}

// ── Reads ────────────────────────────────────────────────────────────

async function findByUser(userId, limit) {
    return Notification.find({ userId })
        .sort({ createdAt: -1 })
        .limit(limit || 50);
}

async function getUnreadCount(userId) {
    return Notification.countDocuments({ userId, isRead: false });
}

// ── Updates (isRead state ONLY - see file header comment) ─────────────

// Ownership-scoped, same pattern as the other repositories.
async function markAsRead(notificationId, userId) {
    const updated = await Notification.findOneAndUpdate(
        { _id: notificationId, userId, isRead: false },
        { isRead: true, readAt: new Date() },
        { new: true }
    );

    // The cached inbox includes isRead per-item AND unreadCount - both
    // go stale the moment this succeeds. null (no match - already read,
    // wrong owner, or doesn't exist) means nothing actually changed, so
    // there's nothing to invalidate.
    if (updated) {
        invalidateInboxCache(userId);
    }

    return updated;
}

async function markAllAsReadForUser(userId) {
    const result = await Notification.updateMany({ userId, isRead: false }, { isRead: true, readAt: new Date() });

    if (result.modifiedCount > 0) {
        invalidateInboxCache(userId);
    }

    return result.modifiedCount;
}

module.exports = {
    createForAlertTrigger,
    create,
    findByUser,
    getUnreadCount,
    markAsRead,
    markAllAsReadForUser,
};
