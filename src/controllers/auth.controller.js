// src/controllers/auth.controller.js
//
// Thin HTTP layer over auth.service.js. This is the ONLY place that
// touches res.cookie() for the refresh token - the service layer
// returns plain data and knows nothing about HTTP/cookies, keeping it
// testable without Express (see the manual tests in File 36).

'use strict';

const config = require('../config/env');
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

// Builds the cookie options object, omitting `domain` entirely unless
// one was explicitly configured. An explicit Domain attribute makes a
// cookie host-SPECIFIC (e.g. only ever sent back to exactly
// "localhost") - omitting it makes the cookie host-ONLY, meaning it's
// automatically scoped to whatever host actually served the response.
// That's the correct default for portability: it works identically
// whether the API is reached via localhost, 127.0.0.1, a raw IP in
// testing, or a real production domain - all without config changes.
// Only set COOKIE_DOMAIN explicitly if you need cross-SUBDOMAIN sharing
// (e.g. api.example.com and app.example.com both need this cookie).
function buildCookieOptions(extra) {
    const options = Object.assign({
            httpOnly: true,
            secure: config.cookie.secure,
            sameSite: 'lax',
            path: '/api/auth',
        },
        extra
    );

    if (config.cookie.domain) {
        options.domain = config.cookie.domain;
    }

    return options;
}

function setRefreshCookie(res, token) {
    res.cookie(
        config.cookie.refreshCookieName,
        token,
        buildCookieOptions({ maxAge: parseExpiryToMs(config.refreshToken.expiresIn) })
    );
}

function clearRefreshCookie(res) {
    res.clearCookie(config.cookie.refreshCookieName, buildCookieOptions());
}

function getRequestMeta(req) {
    return {
        userAgent: req.headers['user-agent'] || null,
        ip: req.ip || null,
    };
}

// ── Handlers ─────────────────────────────────────────────────────────
// Request body shape/presence is validated by validate.middleware.js +
// src/validators/auth.validators.js at the route layer (auth.routes.js)
// before either handler below ever runs - req.body.name/email/password
// are guaranteed present, non-empty, and (for email) well-formed here.

async function signup(req, res) {
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