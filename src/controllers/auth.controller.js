// src/controllers/auth.controller.js
//
// Thin HTTP layer over auth.service.js. This is the ONLY place that
// touches res.cookie() for the refresh token - the service layer
// returns plain data and knows nothing about HTTP/cookies, keeping it
// testable without Express (see the manual tests in File 36).

'use strict';

const config = require('../config/env');
const ApiError = require('../utils/ApiError');
const authService = require('../services/auth.service');

// ── Cookie helpers ───────────────────────────────────────────────────

// Converts simple '15m' / '7d' style strings to milliseconds. Small and
// explicit rather than pulling in the `ms` package - per the "avoid
// unnecessary dependencies" rule, this one conversion doesn't justify a
// new dependency.
function parseExpiryToMs(expiryString) {
    const match = String(expiryString).match(/^(\d+)([smhd])$/);
    if (!match) return 7 * 24 * 60 * 60 * 1000; // sane fallback: 7 days

    const value = parseInt(match[1], 10);
    const unit = match[2];
    const unitMs = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    return value * unitMs[unit];
}

function setRefreshCookie(res, token) {
    res.cookie(config.cookie.refreshCookieName, token, {
        httpOnly: true, // inaccessible to frontend JS - the whole point, defends against XSS token theft
        secure: config.cookie.secure, // true in production (HTTPS only), false for local http:// dev
        sameSite: 'lax', // allows the cookie on top-level navigation, blocks most CSRF vectors
        domain: config.cookie.domain,
        maxAge: parseExpiryToMs(config.refreshToken.expiresIn),
        path: '/api/auth', // only sent to auth endpoints - refresh/logout - not every request
    });
}

function clearRefreshCookie(res) {
    res.clearCookie(config.cookie.refreshCookieName, {
        httpOnly: true,
        secure: config.cookie.secure,
        sameSite: 'lax',
        domain: config.cookie.domain,
        path: '/api/auth',
    });
}

function getRequestMeta(req) {
    return {
        userAgent: req.headers['user-agent'] || null,
        ip: req.ip || null,
    };
}

// ── Basic presence validation (see file header note re: future validators) ──
function requireFields(body, fields) {
    for (let i = 0; i < fields.length; i++) {
        const field = fields[i];
        if (!body[field] || typeof body[field] !== 'string' || body[field].trim() === '') {
            throw ApiError.badRequest('Missing or invalid field: ' + field);
        }
    }
}

// ── Handlers ─────────────────────────────────────────────────────────

async function signup(req, res) {
    requireFields(req.body, ['name', 'email', 'password']);

    const result = await authService.signup(
        req.body.name.trim(),
        req.body.email.trim(),
        req.body.password,
        getRequestMeta(req)
    );

    setRefreshCookie(res, result.refreshToken);

    res.status(201).json({
        success: true,
        user: result.user,
        accessToken: result.accessToken,
    });
}

async function login(req, res) {
    requireFields(req.body, ['email', 'password']);

    const result = await authService.login(
        req.body.email.trim(),
        req.body.password,
        getRequestMeta(req)
    );

    setRefreshCookie(res, result.refreshToken);

    res.status(200).json({
        success: true,
        user: result.user,
        accessToken: result.accessToken,
    });
}

async function refresh(req, res) {
    const rawRefreshToken = req.cookies ? req.cookies[config.cookie.refreshCookieName] : null;

    const result = await authService.refreshAccessToken(rawRefreshToken, getRequestMeta(req));

    setRefreshCookie(res, result.refreshToken);

    res.status(200).json({
        success: true,
        accessToken: result.accessToken,
    });
}

async function logout(req, res) {
    const rawRefreshToken = req.cookies ? req.cookies[config.cookie.refreshCookieName] : null;

    await authService.logout(rawRefreshToken);
    clearRefreshCookie(res);

    res.status(200).json({ success: true, message: 'Logged out' });
}

module.exports = { signup, login, refresh, logout };