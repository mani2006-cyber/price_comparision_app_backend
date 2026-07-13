// src/services/auth.service.js
//
// Business logic for signup/login/refresh/logout. Controllers call this
// layer only. Access tokens are short-lived, stateless JWTs. Refresh
// tokens are ALSO signed JWTs (for stateless expiry/signature checks)
// but are additionally tracked in the DB via refreshToken.repository.js
// to support revocation and rotation, which a stateless-only token
// cannot provide.

'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config/env');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const userRepository = require('../repositories/user.repository');
const refreshTokenRepository = require('../repositories/refreshToken.repository');
const crypto = require('crypto');

// ── Token generation ─────────────────────────────────────────────────

function generateAccessToken(userId) {
    return jwt.sign({
            userId: userId.toString(),

            jti: crypto.randomBytes(16).toString('hex'),
        },
        config.accessToken.secret, { expiresIn: config.accessToken.expiresIn }
    );
}

function generateRefreshToken(userId) {
    const token = jwt.sign({
            userId: userId.toString(),
            // Random per-issuance ID - guarantees a unique token even if two
            // refresh tokens are issued for the same user within the same
            // second (same iat), which would otherwise produce a byte-
            // identical JWT and collide on the tokenHash unique index.
            jti: crypto.randomBytes(16).toString('hex'),
        },
        config.refreshToken.secret, { expiresIn: config.refreshToken.expiresIn }
    );
    const decoded = jwt.decode(token);
    const expiresAt = new Date(decoded.exp * 1000);
    return { token, expiresAt };
}

async function issueTokenPair(userId, meta) {
    const accessToken = generateAccessToken(userId);
    const refresh = generateRefreshToken(userId);

    await refreshTokenRepository.create(userId, refresh.token, refresh.expiresAt, meta);

    return { accessToken, refreshToken: refresh.token };
}

// ── Signup ───────────────────────────────────────────────────────────
async function signup(name, email, password, meta) {
    const alreadyExists = await userRepository.existsByEmail(email);
    if (alreadyExists) {
        throw ApiError.conflict('Email is already registered');
    }

    const user = await userRepository.create({ name, email, password });
    const tokens = await issueTokenPair(user._id, meta);

    return { user, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
}

// ── Login ────────────────────────────────────────────────────────────
async function login(email, password, meta) {
    const user = await userRepository.findByEmailWithPassword(email);

    if (!user) {
        throw ApiError.unauthorized('Invalid email or password');
    }

    const passwordMatches = await user.comparePassword(password);
    if (!passwordMatches) {
        throw ApiError.unauthorized('Invalid email or password');
    }

    const tokens = await issueTokenPair(user._id, meta);

    return { user, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
}

// ── Refresh ──────────────────────────────────────────────────────────
async function refreshAccessToken(rawRefreshToken, meta) {
    if (!rawRefreshToken) {
        throw ApiError.unauthorized('No refresh token provided');
    }

    // Layer 1: JWT signature + expiry - stateless, no DB hit.
    let decoded;
    try {
        decoded = jwt.verify(rawRefreshToken, config.refreshToken.secret);
    } catch (err) {
        throw ApiError.unauthorized('Invalid or expired refresh token');
    }

    // Layer 2: DB - is this SPECIFIC token still valid (not revoked)?
    const validRecord = await refreshTokenRepository.findValidByRawToken(rawRefreshToken);

    if (!validRecord) {
        // Cryptographically valid, but not valid in the DB - either it was
        // never issued by us, or (more concerning) it WAS issued but has
        // since been revoked/rotated past. Check which case this is.
        const anyRecord = await refreshTokenRepository.findAnyByRawToken(rawRefreshToken);

        if (anyRecord && anyRecord.revoked) {
            // Reuse of an already-rotated/revoked token - strong signal of
            // theft, since the legitimate user's own next refresh already
            // moved past this one. Incident response: revoke EVERYTHING for
            // this user, forcing a fresh login on every device.
            logger.warn('Refresh token reuse detected - revoking all sessions for user', {
                userId: anyRecord.userId.toString(),
            });
            await refreshTokenRepository.revokeAllForUser(anyRecord.userId);
        }

        throw ApiError.unauthorized('Invalid or expired refresh token');
    }

    // Both layers passed - rotate: issue a new pair, revoke this one,
    // link them for the audit chain.
    const newAccessToken = generateAccessToken(decoded.userId);
    const newRefresh = generateRefreshToken(decoded.userId);

    await refreshTokenRepository.rotate(validRecord, newRefresh.token, newRefresh.expiresAt, meta);

    return { accessToken: newAccessToken, refreshToken: newRefresh.token };
}

// ── Logout ───────────────────────────────────────────────────────────
async function logout(rawRefreshToken) {
    if (!rawRefreshToken) {
        return; // nothing to revoke - idempotent, not an error
    }

    const record = await refreshTokenRepository.findAnyByRawToken(rawRefreshToken);
    if (record && !record.revoked) {
        await refreshTokenRepository.revokeById(record._id);
    }
    // If not found or already revoked, logout still "succeeds" silently -
    // the end state the caller wants (this token no longer works) is
    // already true either way.
}

module.exports = {
    signup,
    login,
    refreshAccessToken,
    logout,
    generateAccessToken, // exported for auth.middleware.js to reuse the same verify logic's counterpart
};