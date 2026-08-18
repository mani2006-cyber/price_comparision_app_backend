// src/middleware/adminAuth.middleware.js
//
// Gates every /api/admin/products/* route with a single shared secret
// (sent as the x-admin-key header), NOT the user JWT system
// (auth.middleware.js) - there's no per-user admin role/account yet, this
// is a service-account-style check. Fails CLOSED: if ADMIN_API_KEY isn't
// configured at all, every request is rejected, never silently allowed
// through - see config/env.js's own comment on config.admin.apiKey for
// why that's the opposite default from an optional feature like OpenRouter.

'use strict';

const config = require('../config/env');
const ApiError = require('../utils/ApiError');

function requireAdmin(req, res, next) {
    if (!config.admin.apiKey) {
        return next(ApiError.internal('Admin routes are not configured (ADMIN_API_KEY is unset)'));
    }

    const provided = req.headers['x-admin-key'];
    if (!provided || provided !== config.admin.apiKey) {
        return next(ApiError.unauthorized('Invalid or missing admin key'));
    }

    next();
}

module.exports = { requireAdmin };
