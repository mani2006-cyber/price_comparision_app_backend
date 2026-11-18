// src/routes/auth.routes.js
//
// Public authentication routes are rate-limited; account-security
// management routes additionally require a valid access token.

'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middleware/validate.middleware');
const {
    signupBodySchema,
    loginBodySchema,
    emailBodySchema,
    passwordResetBodySchema,
    passwordChangeBodySchema,
    loginMfaBodySchema,
    emailMfaChallengeBodySchema,
    emailMfaVerifyBodySchema,
} = require('../validators/auth.validators');
const authController = require('../controllers/auth.controller');
const config = require('../config/env');
const { requireAuth } = require('../middleware/auth.middleware');
const requireTurnstile = require('../middleware/turnstile.middleware');

const router = express.Router();

// Stricter than the general API rate limit - signup/login are the
// endpoints most worth protecting against brute-force/credential
// stuffing attempts specifically.


const authRateLimiter = rateLimit({
    windowMs: config.authRateLimit.windowMs,
    max: config.authRateLimit.max,
    message: { success: false, error: 'Too many auth attempts, please try again later' },
    standardHeaders: true,
    legacyHeaders: false,
});

// authRateLimiter runs BEFORE validate() - rate limiting has to count
// every attempt, including malformed ones, or an attacker could send
// intentionally-invalid bodies forever without ever tripping it.
router.post(
    '/signup',
    authRateLimiter,
    validate({ body: signupBodySchema }),
    requireTurnstile('signup'),
    asyncHandler(authController.signup)
);
router.post(
    '/login',
    authRateLimiter,
    validate({ body: loginBodySchema }),
    requireTurnstile('login'),
    asyncHandler(authController.login)
);
router.post('/login/mfa', authRateLimiter, validate({ body: loginMfaBodySchema }), asyncHandler(authController.loginMfa));
router.post('/password/forgot', authRateLimiter, validate({ body: emailBodySchema }), asyncHandler(authController.requestPasswordReset));
router.post('/password/reset', authRateLimiter, validate({ body: passwordResetBodySchema }), asyncHandler(authController.completePasswordReset));
router.post('/password/change', authRateLimiter, requireAuth, validate({ body: passwordChangeBodySchema }), asyncHandler(authController.changePassword));
router.post(
    '/mfa/email/challenge',
    authRateLimiter,
    requireAuth,
    validate({ body: emailMfaChallengeBodySchema }),
    asyncHandler(authController.beginEmailMfaChallenge)
);
router.post(
    '/mfa/email/verify',
    authRateLimiter,
    requireAuth,
    validate({ body: emailMfaVerifyBodySchema }),
    asyncHandler(authController.completeEmailMfaChallenge)
);
router.post('/refresh', asyncHandler(authController.refresh));
router.post('/logout', asyncHandler(authController.logout));

module.exports = router;