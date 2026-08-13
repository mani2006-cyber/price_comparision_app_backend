// src/routes/notification.routes.js
//
// All notification endpoints require authentication - same reasoning as
// wishlist.routes.js and alert.routes.js. GET / is cached (see
// notificationCache below), invalidated on every write in
// notification.repository.js. /stream is the real-time SSE push
// endpoint - see notification.controller.js's `stream` handler.
//
// /stream is registered BEFORE the blanket router.use(requireAuth)
// below, with its own requireAuthForStream applied directly - Express
// middleware runs in registration order along the matched path, so if
// requireAuth (header-only) were registered first, it would reject
// every /stream request before requireAuthForStream (header OR
// ?token=) ever got a chance to accept the query-param form an
// EventSource connection actually needs.

'use strict';

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireAuthForStream } = require('../middleware/auth.middleware');
const { cacheResponse } = require('../middleware/cache.middleware');
const config = require('../config/env');
const notificationController = require('../controllers/notification.controller');

const router = express.Router();

const notificationCache = cacheResponse({
    keyPrefix: 'notifications',
    ttlSeconds: config.cacheTtl.notifications,
    // Only the default-limit inbox view is cached under one key per
    // user (see notification.repository.js's inboxCacheKey - it must
    // match this keyBuilder exactly for invalidation to actually hit
    // the right entry). A caller requesting a custom ?limit= bypasses
    // the cache entirely rather than serving a limit-agnostic cached
    // response for a request that explicitly asked for something
    // different.
    skip: function(req) { return req.query.limit !== undefined; },
    keyBuilder: function(req) { return req.userId; },
});

router.get('/stream', requireAuthForStream, asyncHandler(notificationController.stream));

router.use(requireAuth); // applies to every route below

router.get('/', notificationCache, asyncHandler(notificationController.getInbox));
router.post('/:id/read', asyncHandler(notificationController.markAsRead));
router.post('/read-all', asyncHandler(notificationController.markAllAsRead));

module.exports = router;
