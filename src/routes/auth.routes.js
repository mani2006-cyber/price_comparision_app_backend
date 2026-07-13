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
const authController = require('../controllers/auth.controller');

const router = express.Router();

// Stricter than the general API rate limit - signup/login are the
// endpoints most worth protecting against brute-force/credential
// stuffing attempts specifically.
const authRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10,
    message: { success: false, error: 'Too many auth attempts, please try again later' },
    standardHeaders: true,
    legacyHeaders: false,
});

router.post('/signup', authRateLimiter, asyncHandler(authController.signup));
router.post('/login', authRateLimiter, asyncHandler(authController.login));
router.post('/refresh', asyncHandler(authController.refresh));
router.post('/logout', asyncHandler(authController.logout));

module.exports = router;