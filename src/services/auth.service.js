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
const emailService = require('./email.service');
const mfaChallengeRepository = require('../repositories/mfaChallenge.repository');
const passwordResetTokenRepository = require('../repositories/passwordResetToken.repository');

const MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const PASSWORD_RESET_CODE_TTL_MS = 5 * 60 * 1000;

function auditMetadata(meta, extra) {
    return Object.assign({
        sourceIp: meta && meta.ip || null,
        userAgent: meta && meta.userAgent || null,
    }, extra);
}

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
    logger.security('Account created', {
        userId: user._id.toString(),
        sourceIp: meta && meta.ip,
        outcome: 'success',
    });

    return { user, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
}

// ── Login ────────────────────────────────────────────────────────────
async function login(email, password, meta) {
    const user = await userRepository.findByEmailWithPassword(email);

    if (!user) {
        logger.security('Authentication failed', {
            sourceIp: meta && meta.ip,
            userAgent: meta && meta.userAgent,
            reason: 'invalid_credentials',
            outcome: 'failure',
        }, 'warn');
        throw ApiError.unauthorized('Invalid email or password');
    }

    const passwordMatches = await user.comparePassword(password);
    if (!passwordMatches) {
        logger.security('Authentication failed', {
            sourceIp: meta && meta.ip,
            userAgent: meta && meta.userAgent,
            reason: 'invalid_credentials',
            outcome: 'failure',
        }, 'warn');
        throw ApiError.unauthorized('Invalid email or password');
    }

    if (user.emailMfaEnabled) {
        const challenge = await createEmailMfaChallenge(user, 'login', meta);
        return Object.assign({ mfaRequired: true }, challenge);
    }

    const tokens = await issueTokenPair(user._id, meta);
    logger.security('Authentication succeeded', auditMetadata(meta, {
        userId: user._id.toString(),
        outcome: 'success',
    }));

    return Object.assign({ user, mfaRequired: false }, tokens);
}

async function createEmailMfaChallenge(user, purpose, meta) {
    if (!emailService.isConfigured()) {
        logger.security('MFA challenge failed', auditMetadata(meta, {
            userId: user._id.toString(),
            purpose,
            reason: 'email_delivery_not_configured',
            outcome: 'failure',
        }), 'error');
    }
    emailService.assertConfigured();

    const challengeToken = crypto.randomBytes(32).toString('base64url');
    const otp = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const expiresAt = new Date(Date.now() + MFA_CHALLENGE_TTL_MS);
    await mfaChallengeRepository.invalidateActiveForUser(user._id, purpose);
    await mfaChallengeRepository.create(user._id, challengeToken, otp, purpose, expiresAt);

    try {
        await emailService.sendMfaCode(user.email, otp, purpose);
    } catch (err) {
        await mfaChallengeRepository.deleteByRawToken(challengeToken);
        logger.security('MFA challenge delivery failed', auditMetadata(meta, {
            userId: user._id.toString(),
            purpose,
            outcome: 'failure',
        }), 'error');
        throw err;
    }

    logger.security('MFA challenge issued', auditMetadata(meta, {
        userId: user._id.toString(),
        purpose,
        outcome: 'success',
    }));
    return { challengeToken, expiresInSeconds: MFA_CHALLENGE_TTL_MS / 1000 };
}

function hashMatches(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string') {
        return false;
    }
    const leftBuffer = Buffer.from(left, 'hex');
    const rightBuffer = Buffer.from(right, 'hex');
    return leftBuffer.length === rightBuffer.length &&
        leftBuffer.length > 0 &&
        crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

async function consumeEmailMfaChallenge(rawChallengeToken, otp, expectedPurpose, expectedUserId, meta) {
    const challenge = rawChallengeToken
        ? await mfaChallengeRepository.findValidByRawToken(rawChallengeToken)
        : null;
    const expectedPurposes = Array.isArray(expectedPurpose) ? expectedPurpose : [expectedPurpose];

    if (!challenge ||
        expectedPurposes.indexOf(challenge.purpose) === -1 ||
        (expectedUserId && challenge.userId.toString() !== expectedUserId.toString())) {
        logger.security('MFA verification failed', auditMetadata(meta, {
            userId: expectedUserId ? expectedUserId.toString() : undefined,
            reason: 'invalid_challenge',
            outcome: 'failure',
        }), 'warn');
        throw ApiError.unauthorized('Invalid or expired verification challenge');
    }

    const expectedCodeHash = mfaChallengeRepository.hashCode(challenge.userId, challenge.purpose, otp);
    if (!hashMatches(challenge.codeHash, expectedCodeHash)) {
        await mfaChallengeRepository.incrementFailedAttempt(rawChallengeToken);
        logger.security('MFA verification failed', auditMetadata(meta, {
            userId: challenge.userId.toString(),
            reason: 'invalid_code',
            outcome: 'failure',
        }), 'warn');
        throw ApiError.unauthorized('Invalid or expired verification challenge');
    }

    const consumed = await mfaChallengeRepository.consume(
        rawChallengeToken,
        challenge.userId,
        challenge.purpose,
        otp
    );
    if (!consumed) {
        logger.security('MFA verification failed', auditMetadata(meta, {
            userId: challenge.userId.toString(),
            reason: 'challenge_already_used',
            outcome: 'failure',
        }), 'warn');
        throw ApiError.unauthorized('Invalid or expired verification challenge');
    }

    return consumed;
}

async function completeLoginMfa(rawChallengeToken, otp, meta) {
    const challenge = await consumeEmailMfaChallenge(rawChallengeToken, otp, 'login', null, meta);
    const user = await userRepository.findById(challenge.userId);
    if (!user || !user.emailMfaEnabled) {
        throw ApiError.unauthorized('Invalid or expired verification challenge');
    }

    const tokens = await issueTokenPair(user._id, meta);
    logger.security('Authentication succeeded', auditMetadata(meta, {
        userId: user._id.toString(),
        mfa: 'email',
        outcome: 'success',
    }));
    return Object.assign({ user }, tokens);
}

async function beginEmailMfaChallenge(userId, password, action, meta) {
    const user = await userRepository.findByIdWithPassword(userId);
    if (!user || !(await user.comparePassword(password))) {
        logger.security('MFA configuration failed', auditMetadata(meta, {
            userId: userId.toString(),
            reason: 'invalid_password',
            outcome: 'failure',
        }), 'warn');
        throw ApiError.unauthorized('Current password is incorrect');
    }

    if ((action === 'enable' && user.emailMfaEnabled) ||
        (action === 'disable' && !user.emailMfaEnabled)) {
        throw ApiError.conflict(action === 'enable'
            ? 'Email MFA is already enabled'
            : 'Email MFA is not enabled');
    }

    const purpose = action === 'enable' ? 'enable_email_mfa' : 'disable_email_mfa';
    return createEmailMfaChallenge(user, purpose, meta);
}

async function completeEmailMfaChallenge(userId, rawChallengeToken, otp, meta) {
    const challenge = await consumeEmailMfaChallenge(
        rawChallengeToken,
        otp,
        ['enable_email_mfa', 'disable_email_mfa'],
        userId,
        meta
    );
    const enabled = challenge.purpose === 'enable_email_mfa';
    const user = await userRepository.setEmailMfaEnabled(userId, enabled);
    if (!user) {
        throw ApiError.unauthorized('User account no longer exists');
    }

    logger.security(enabled ? 'Email MFA enabled' : 'Email MFA disabled', auditMetadata(meta, {
        userId: userId.toString(),
        outcome: 'success',
    }));
    return { emailMfaEnabled: enabled };
}

async function changePassword(userId, currentPassword, newPassword, meta) {
    const user = await userRepository.findByIdWithPassword(userId);
    if (!user || !(await user.comparePassword(currentPassword))) {
        logger.security('Password change failed', auditMetadata(meta, {
            userId: userId.toString(),
            reason: 'invalid_current_password',
            outcome: 'failure',
        }), 'warn');
        throw ApiError.unauthorized('Current password is incorrect');
    }

    const updatedUser = await userRepository.updatePasswordById(userId, newPassword);
    if (!updatedUser) {
        throw ApiError.unauthorized('User account no longer exists');
    }
    await refreshTokenRepository.revokeAllForUser(userId);

    logger.security('Password changed', auditMetadata(meta, {
        userId: userId.toString(),
        outcome: 'success',
    }));
    return { success: true };
}

function recoveryResponse() {
    return {
        accepted: true,
        message: 'If an account exists for that email, password reset instructions will be sent.',
    };
}

async function requestPasswordReset(email, meta) {
    if (!emailService.isConfigured()) {
        logger.security('Account recovery unavailable', auditMetadata(meta, {
            reason: 'email_delivery_not_configured',
            outcome: 'failure',
        }), 'error');
    }
    emailService.assertConfigured();
    const user = await userRepository.findByEmail(email);
    if (!user) {
        logger.security('Account recovery requested', auditMetadata(meta, {
            outcome: 'no_matching_account',
        }));
        return recoveryResponse();
    }

    const otp = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_CODE_TTL_MS);
    await passwordResetTokenRepository.invalidateForUser(user._id);
    await passwordResetTokenRepository.create(user._id, otp, expiresAt);

    try {
        await emailService.sendPasswordResetCode(user.email, otp);
    } catch (err) {
        await passwordResetTokenRepository.invalidateForUser(user._id);
        logger.security('Account recovery email delivery failed', auditMetadata(meta, {
            userId: user._id.toString(),
            outcome: 'failure',
        }), 'error');
        // Keep the response identical to an unknown account; delivery failures remain visible in security logs.
        return recoveryResponse();
    }

    logger.security('Account recovery requested', auditMetadata(meta, {
        userId: user._id.toString(),
        outcome: 'email_sent',
    }));
    return recoveryResponse();
}

async function completePasswordReset(email, otp, newPassword, meta) {
    const user = await userRepository.findByEmail(email);
    const resetRecord = user
        ? await passwordResetTokenRepository.consume(user._id, otp)
        : null;
    if (!resetRecord || !user) {
        logger.security('Account recovery failed', auditMetadata(meta, {
            reason: 'invalid_or_expired_code',
            outcome: 'failure',
        }), 'warn');
        throw ApiError.unauthorized('Invalid or expired password reset code');
    }

    const updatedUser = await userRepository.updatePasswordById(user._id, newPassword);
    if (!updatedUser) {
        logger.security('Account recovery failed', auditMetadata(meta, {
            reason: 'account_not_found',
            outcome: 'failure',
        }), 'warn');
        throw ApiError.unauthorized('Invalid or expired password reset code');
    }

    await Promise.all([
        refreshTokenRepository.revokeAllForUser(updatedUser._id),
        passwordResetTokenRepository.invalidateForUser(updatedUser._id),
    ]);
    logger.security('Account recovery completed', auditMetadata(meta, {
        userId: updatedUser._id.toString(),
        outcome: 'success',
    }));
    return { success: true };
}

// ── Refresh ──────────────────────────────────────────────────────────
async function refreshAccessToken(rawRefreshToken, meta) {
    if (!rawRefreshToken) {
        logger.security('Refresh token rejected', {
            sourceIp: meta && meta.ip,
            reason: 'missing_token',
            outcome: 'failure',
        }, 'warn');
        throw ApiError.unauthorized('No refresh token provided');
    }

    // Layer 1: JWT signature + expiry - stateless, no DB hit.
    let decoded;
    try {
        decoded = jwt.verify(rawRefreshToken, config.refreshToken.secret);
    } catch (err) {
        logger.security('Refresh token rejected', {
            sourceIp: meta && meta.ip,
            reason: 'invalid_or_expired',
            outcome: 'failure',
        }, 'warn');
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
            logger.security('Refresh token reuse detected - revoking all sessions for user', {
                userId: anyRecord.userId.toString(),
                sourceIp: meta && meta.ip,
                outcome: 'failure',
            }, 'warn');
            await refreshTokenRepository.revokeAllForUser(anyRecord.userId);
        }

        logger.security('Refresh token rejected', {
            sourceIp: meta && meta.ip,
            reason: 'not_active',
            outcome: 'failure',
        }, 'warn');
        throw ApiError.unauthorized('Invalid or expired refresh token');
    }

    // Both layers passed - rotate: issue a new pair, revoke this one,
    // link them for the audit chain.
    const newAccessToken = generateAccessToken(decoded.userId);
    const newRefresh = generateRefreshToken(decoded.userId);

    await refreshTokenRepository.rotate(validRecord, newRefresh.token, newRefresh.expiresAt, meta);
    logger.security('Refresh token rotated', {
        userId: decoded.userId,
        sourceIp: meta && meta.ip,
        outcome: 'success',
    });

    return { accessToken: newAccessToken, refreshToken: newRefresh.token };
}

// ── Logout ───────────────────────────────────────────────────────────
async function logout(rawRefreshToken, meta) {
    if (!rawRefreshToken) {
        logger.security('Session logout requested', auditMetadata(meta, {
            outcome: 'success',
            reason: 'no_refresh_token',
        }));
        return; // nothing to revoke - idempotent, not an error
    }

    const record = await refreshTokenRepository.findAnyByRawToken(rawRefreshToken);
    if (record && !record.revoked) {
        await refreshTokenRepository.revokeById(record._id);
        logger.security('Session logged out', {
            userId: record.userId.toString(),
            sourceIp: meta && meta.ip,
            userAgent: meta && meta.userAgent,
            outcome: 'success',
        });
    } else {
        logger.security('Session logout requested', auditMetadata(meta, {
            userId: record ? record.userId.toString() : undefined,
            outcome: 'success',
            reason: record ? 'already_revoked' : 'unknown_token',
        }));
    }
    // If not found or already revoked, logout still "succeeds" silently -
    // the end state the caller wants (this token no longer works) is
    // already true either way.
}

module.exports = {
    signup,
    login,
    completeLoginMfa,
    beginEmailMfaChallenge,
    completeEmailMfaChallenge,
    changePassword,
    requestPasswordReset,
    completePasswordReset,
    refreshAccessToken,
    logout,
    generateAccessToken, // exported for auth.middleware.js to reuse the same verify logic's counterpart
};