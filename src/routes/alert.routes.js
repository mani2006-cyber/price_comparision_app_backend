// src/routes/alert.routes.js
//
// All alert endpoints require authentication - same reasoning as
// wishlist.routes.js. Cancel is a soft state transition (active ->
// cancelled, see alert.repository.js's cancelByIdForUser) for an active
// alert specifically. DELETE is a genuine hard delete - removing an
// alert from the user's list entirely, regardless of its status (active,
// triggered, or already cancelled) - the two are separate actions with
// separate routes on purpose.

'use strict';

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/auth.middleware');
const validate = require('../middleware/validate.middleware');
const { createAlertBodySchema } = require('../validators/alert.validators');
const alertController = require('../controllers/alert.controller');

const router = express.Router();

router.use(requireAuth);

router.post('/', validate({ body: createAlertBodySchema }), asyncHandler(alertController.createAlert));
router.get('/', asyncHandler(alertController.getAlerts));
router.post('/:id/cancel', asyncHandler(alertController.cancelAlert));
router.delete('/:id', asyncHandler(alertController.deleteAlert));

module.exports = router;