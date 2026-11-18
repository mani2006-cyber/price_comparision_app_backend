// src/controllers/auth.controller.js
//
// Thin HTTP layer over auth.service.js. This is the ONLY place that
// touches res.cookie() for the refresh token - the service layer
// returns plain data and knows nothing about HTTP/cookies, keeping it
// testable without Express (see the manual tests in File 36).

'use strict';

const config = require('../config/env');
const authService = require('../services/auth.service');
const securityMonitorAgent = require('../security/securityMonitorAgent');

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
    let result;
    try {
        result = await authService.login(
            req.body.email.trim(),
            req.body.password,
            getRequestMeta(req)
        );
    } catch (err) {
        if (err.statusCode === 401) {
            securityMonitorAgent.reportAuth(req, 'failure', req.body.email);
        }
        throw err;
    }

    if (result.mfaRequired) {
        return res.status(202).json({
            success: true,
            mfaRequired: true,
            challengeToken: result.challengeToken,
            expiresInSeconds: result.expiresInSeconds,
        });
    }

    securityMonitorAgent.reportAuth(req, 'success', req.body.email);
    setRefreshCookie(res, result.refreshToken);

    res.status(200).json({
        success: true,
        user: result.user,
        accessToken: result.accessToken,
    });
}

async function loginMfa(req, res) {
    let result;
    try {
        result = await authService.completeLoginMfa(
            req.body.challengeToken,
            req.body.otp,
            getRequestMeta(req)
        );
    } catch (err) {
        if (err.statusCode === 401) {
            securityMonitorAgent.reportAuth(req, 'failure');
        }
        throw err;
    }

    securityMonitorAgent.reportAuth(req, 'success', result.user.email);
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

    await authService.logout(rawRefreshToken, getRequestMeta(req));
    clearRefreshCookie(res);

    res.status(200).json({ success: true, message: 'Logged out' });
}

async function beginEmailMfaChallenge(req, res) {
    const result = await authService.beginEmailMfaChallenge(
        req.userId,
        req.body.password,
        req.body.action,
        getRequestMeta(req)
    );

    res.status(202).json(Object.assign({ success: true }, result));
}

async function completeEmailMfaChallenge(req, res) {
    const result = await authService.completeEmailMfaChallenge(
        req.userId,
        req.body.challengeToken,
        req.body.otp,
        getRequestMeta(req)
    );

    res.status(200).json(Object.assign({ success: true }, result));
}

async function changePassword(req, res) {
    await authService.changePassword(
        req.userId,
        req.body.currentPassword,
        req.body.newPassword,
        getRequestMeta(req)
    );
    clearRefreshCookie(res);
    res.status(200).json({ success: true, message: 'Password changed; please sign in again' });
}

async function requestPasswordReset(req, res) {
    const result = await authService.requestPasswordReset(req.body.email.trim(), getRequestMeta(req));
    res.status(202).json(Object.assign({ success: true }, result));
}

async function completePasswordReset(req, res) {
    await authService.completePasswordReset(
        req.body.email.trim(),
        req.body.otp,
        req.body.password,
        getRequestMeta(req)
    );
    clearRefreshCookie(res);
    res.status(200).json({ success: true, message: 'Password reset successfully; please sign in again' });
}

module.exports = {
    signup,
    login,
    loginMfa,
    refresh,
    logout,
    beginEmailMfaChallenge,
    completeEmailMfaChallenge,
    changePassword,
    requestPasswordReset,
    completePasswordReset,
};