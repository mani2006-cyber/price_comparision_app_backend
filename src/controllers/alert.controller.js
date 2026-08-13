// src/controllers/alert.controller.js
//
// HTTP layer over alert.service.js. Same shape as wishlist.controller.js
// - every route requires auth, ownership enforced at the service layer
// (File 44). createAlert validates targetPrice is a well-formed positive
// number here (HTTP-boundary concern); the service separately validates
// it's actually LOWER than the current price (business-rule concern
// requiring product data the controller doesn't have).

'use strict';

const alertService = require('../services/alert.service');

// Request body shape/presence/numeric-well-formedness is validated by
// validate.middleware.js + src/validators/alert.validators.js at the
// route layer (alert.routes.js) before this ever runs - req.body.productId
// and req.body.targetPrice (already coerced to a real positive number)
// are guaranteed here. The "targetPrice must be lower than the current
// price" business rule still lives in alert.service.js - it needs
// product data this layer doesn't have.
async function createAlert(req, res) {
    const alert = await alertService.createAlert(req.userId, req.body.productId, req.body.targetPrice);
    res.status(201).json({ success: true, alert });
}

async function getAlerts(req, res) {
    const alerts = await alertService.getUserAlerts(req.userId);
    res.status(200).json({ success: true, count: alerts.length, alerts });
}

async function cancelAlert(req, res) {
    const alert = await alertService.cancelAlert(req.params.id, req.userId);
    res.status(200).json({ success: true, alert });
}

module.exports = { createAlert, getAlerts, cancelAlert };