// src/controllers/alert.controller.js
//
// HTTP layer over alert.service.js. Same shape as wishlist.controller.js
// - every route requires auth, ownership enforced at the service layer
// (File 44). createAlert validates targetPrice is a well-formed positive
// number here (HTTP-boundary concern); the service separately validates
// it's actually LOWER than the current price (business-rule concern
// requiring product data the controller doesn't have).

'use strict';

const ApiError = require('../utils/ApiError');
const alertService = require('../services/alert.service');

async function createAlert(req, res) {
    const productId = req.body.productId;
    if (!productId || typeof productId !== 'string') {
        throw ApiError.badRequest("A 'productId' is required");
    }

    const targetPrice = Number(req.body.targetPrice);
    if (!Number.isFinite(targetPrice) || targetPrice <= 0) {
        throw ApiError.badRequest("A positive numeric 'targetPrice' is required");
    }

    const alert = await alertService.createAlert(req.userId, productId, targetPrice);
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