// src/controllers/notification.controller.js
//
// HTTP layer over notification.service.js. Same shape as wishlist/alert
// controllers - every route requires auth, ownership enforced at the
// service layer (File 47).

'use strict';

const notificationService = require('../services/notification.service');

async function getInbox(req, res) {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : undefined;
    const inbox = await notificationService.getInbox(req.userId, limit);
    res.status(200).json({
        success: true,
        unreadCount: inbox.unreadCount,
        notifications: inbox.notifications,
    });
}

async function markAsRead(req, res) {
    const notification = await notificationService.markAsRead(req.params.id, req.userId);
    res.status(200).json({ success: true, notification });
}

async function markAllAsRead(req, res) {
    const result = await notificationService.markAllAsRead(req.userId);
    res.status(200).json({ success: true, modifiedCount: result.modifiedCount });
}

module.exports = { getInbox, markAsRead, markAllAsRead };