'use strict';

const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const logger = require('../utils/logger');
const turnstileService = require('../services/turnstile.service');

function requireTurnstile(action) {
    return asyncHandler(async function(req, res, next) {
        const token = req.body && req.body.captchaToken;
        const valid = await turnstileService.verifyToken(token, req.ip, action);
        if (!valid) {
            logger.security('CAPTCHA verification failed', {
                action,
                sourceIp: req.ip || null,
                outcome: 'failure',
            }, 'warn');
            throw ApiError.forbidden('CAPTCHA verification failed');
        }
        next();
    });
}

module.exports = requireTurnstile;
