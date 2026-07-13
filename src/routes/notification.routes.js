// src/routes/notification.routes.js
//
// All notification endpoints require authentication - same reasoning as
// wishlist.routes.js and alert.routes.js.

'use strict';

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/auth.middleware');
const notificationController = require('../controllers/notification.controller');

const router = express.Router();

router.use(requireAuth);

router.get('/', asyncHandler(notificationController.getInbox));
router.post('/:id/read', asyncHandler(notificationController.markAsRead));
router.post('/read-all', asyncHandler(notificationController.markAllAsRead));

module.exports = router;