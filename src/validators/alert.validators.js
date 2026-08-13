// src/validators/alert.validators.js
//
// Zod schema for alert.routes.js's POST body. Same message text as the
// old manual checks in alert.controller.js so the existing route tests
// (tests/integration/routes/alert.routes.test.js) keep passing
// unchanged - this replaces the controller's own presence/type checks,
// NOT the service-layer "targetPrice must be lower than the current
// price" business rule (alert.service.js still owns that - it needs
// product data this schema doesn't have, same split the controller's
// own header comment already documented).
//
// z.coerce.number() (not z.number()) because a target price arriving
// as a JSON string ("45000") should be treated the same as a JSON
// number (45000) - matching the old controller's own `Number(...)`
// call - while a genuinely non-numeric value ("not-a-number") still
// fails, coercion included.

'use strict';

const { z } = require('zod');

const createAlertBodySchema = z.object({
    productId: z.string("A 'productId' is required").trim().min(1, "A 'productId' is required"),
    targetPrice: z.coerce.number("A positive numeric 'targetPrice' is required")
        .positive("A positive numeric 'targetPrice' is required"),
});

module.exports = { createAlertBodySchema };
