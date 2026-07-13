// src/repositories/notification.repository.js
//
// All direct Mongoose access for the Notification collection.
// createForAlertTrigger is the purpose-built creation path for the one
// producer we already know about (Alert firing) - it owns the message
// formatting so that logic lives in exactly one place. Deliberately no
// generic updateById: once created, only isRead should ever change.

'use strict';

const Notification = require('../models/Notification.model');

// ── Create ───────────────────────────────────────────────────────────

// Purpose-built for the price-refresher job: builds a consistent
// title/message/data shape whenever an Alert's target price is met.
async function createForAlertTrigger(userId, alertId, productTitle, price) {
    return Notification.create({
        userId,
        alertId,
        type: 'price_drop',
        title: 'Price dropped!',
        message: productTitle + ' dropped to ' + '\u20B9' + price,
        data: { alertId, price },
    });
}

// Generic creation path for future notification types (system messages,
// back-in-stock, etc.) that aren't alert-driven.
async function create(userId, type, title, message, data) {
    return Notification.create({
        userId,
        type,
        title,
        message,
        data: data || {},
    });
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
    return Notification.findOneAndUpdate({ _id: notificationId, userId, isRead: false }, { isRead: true, readAt: new Date() }, { new: true });
}

async function markAllAsReadForUser(userId) {
    const result = await Notification.updateMany({ userId, isRead: false }, { isRead: true, readAt: new Date() });
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