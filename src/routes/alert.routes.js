// src/routes/alert.routes.js
//
// All alert endpoints require authentication - same reasoning as
// wishlist.routes.js. Cancel is a soft state transition (active ->
// cancelled, see alert.repository.js's cancelByIdForUser), not a hard
// delete - so this uses a PATCH-style cancel action, not DELETE.

'use strict';

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/auth.middleware');
const alertController = require('../controllers/alert.controller');

const router = express.Router();

router.use(requireAuth);

router.post('/', asyncHandler(alertController.createAlert));
router.get('/', asyncHandler(alertController.getAlerts));
router.post('/:id/cancel', asyncHandler(alertController.cancelAlert));

module.exports = router;