'use strict';

const ApiError = require('../utils/ApiError');
const notificationRepository = require('../repositories/notification.repository');

// ── Inbox (list + unread count together) ──────────────────────────────
async function getInbox(userId, limit) {
    const [notifications, unreadCount] = await Promise.all([
        notificationRepository.findByUser(userId, limit),
        notificationRepository.getUnreadCount(userId),
    ]);

    return { notifications, unreadCount };
}

// ── Mark read ────────────────────────────────────────────────────────
async function markAsRead(notificationId, userId) {
    const updated = await notificationRepository.markAsRead(notificationId, userId);
    if (!updated) {
        throw ApiError.notFound('Notification not found');
    }
    return updated;
}

async function markAllAsRead(userId) {
    const modifiedCount = await notificationRepository.markAllAsReadForUser(userId);
    return { modifiedCount };
}

module.exports = { getInbox, markAsRead, markAllAsRead };