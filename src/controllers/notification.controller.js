// src/controllers/notification.controller.js
//
// HTTP layer over notification.service.js. Same shape as wishlist/alert
// controllers - every route requires auth, ownership enforced at the
// service layer (File 47). `stream` is the exception to "goes through
// the service layer" - it's a long-lived SSE connection, not a
// request/response cycle, so it talks to notificationBus directly
// (subscribing IS the whole job here, there's no business logic to put
// in a service).

'use strict';

const notificationService = require('../services/notification.service');
const notificationBus = require('../realtime/notificationBus');
const logger = require('../utils/logger');

// How often to write a comment-only "ping" line while nothing real is
// happening. Two jobs: (1) keeps the connection alive through any
// intermediary (reverse proxy, load balancer) that drops idle
// connections after a timeout shorter than a user might realistically
// go between notifications: (2) lets the server detect a half-open
// connection (client vanished without a clean TCP close, e.g. a lost
// wifi connection) once a write to it starts failing.
const SSE_HEARTBEAT_MS = 25000;

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

// ── Real-time push (SSE) ─────────────────────────────────────────────
//
// GET /api/notifications/stream - opens a Server-Sent Events connection
// that stays open until the client disconnects. Every notification
// created for req.userId (from ANY code path - alert.service.js, a
// future feature, whatever - see notification.repository.js, the one
// place notificationBus.publish() is actually called) is written to
// this connection the moment it's created, with no polling involved.
function stream(req, res) {
    res.status(200).set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        // Disables response buffering on nginx specifically, if this is
        // ever deployed behind one - a buffered SSE response defeats the
        // entire point (nothing reaches the client until the buffer
        // fills or the connection closes). Harmless no-op on any other
        // front end/no proxy at all.
        'X-Accel-Buffering': 'no',
    });
    if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
    }

    // Opens the stream immediately - a comment line (":" prefix) is not
    // a real SSE event, but writing ANYTHING is what makes the client's
    // EventSource fire its 'open' handler right away instead of only
    // once the first real notification eventually arrives.
    res.write(': connected\n\n');

    const unsubscribe = notificationBus.subscribe(req.userId, function(notification) {
        res.write('event: notification\ndata: ' + JSON.stringify(notification) + '\n\n');
    });

    const heartbeat = setInterval(function() {
        res.write(': ping\n\n');
    }, SSE_HEARTBEAT_MS);

    function cleanup() {
        clearInterval(heartbeat);
        unsubscribe();
    }

    // Fires on a clean client-initiated disconnect (tab closed, page
    // navigated away, EventSource.close() called) AND on the underlying
    // socket being destroyed - the one place this connection's lifetime
    // ever ends, so it's the one place cleanup needs to happen.
    req.on('close', function() {
        cleanup();
        logger.debug('Notification stream closed', { userId: req.userId });
    });

    logger.debug('Notification stream opened', { userId: req.userId });
}

module.exports = { getInbox, markAsRead, markAllAsRead, stream };
