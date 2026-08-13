// src/routes/auth.routes.js
//
// Routes for signup/login/refresh/logout. No auth middleware on any of
// these - see file header comment for why each one is deliberately
// unprotected. A stricter rate limiter is applied to signup/login
// specifically, tighter than the general app-wide limiter.

'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middleware/validate.middleware');
const { signupBodySchema, loginBodySchema } = require('../validators/auth.validators');
const authController = require('../controllers/auth.controller');
const config = require('../config/env');

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
router.post('/signup', authRateLimiter, validate({ body: signupBodySchema }), asyncHandler(authController.signup));
router.post('/login', authRateLimiter, validate({ body: loginBodySchema }), asyncHandler(authController.login));
router.post('/refresh', asyncHandler(authController.refresh));
router.post('/logout', asyncHandler(authController.logout));

module.exports = router;