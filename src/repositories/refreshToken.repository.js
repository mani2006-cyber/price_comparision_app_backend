// src/repositories/refreshToken.repository.js
//
// All direct Mongoose access for the RefreshToken collection. Callers
// (auth.service.js) always work with the RAW token value - hashing
// happens internally here, at the DB boundary, never exposed to callers.

'use strict';

const RefreshToken = require('../models/RefreshToken.model');

// ── Create ───────────────────────────────────────────────────────────
async function create(userId, rawToken, expiresAt, meta) {
    return RefreshToken.create({
        userId,
        tokenHash: RefreshToken.hashToken(rawToken),
        expiresAt,
        userAgent: (meta && meta.userAgent) || null,
        ip: (meta && meta.ip) || null,
    });
}

// ── Reads ────────────────────────────────────────────────────────────

// The core lookup for /api/auth/refresh. Checks expiresAt explicitly
// (not just relying on the TTL index) - Mongo's TTL sweep runs on a
// background interval, not instantly, so a token could be logically
// expired for up to ~60s before it's actually deleted. This closes
// that window.
async function findValidByRawToken(rawToken) {
    const tokenHash = RefreshToken.hashToken(rawToken);
    return RefreshToken.findOne({
        tokenHash,
        revoked: false,
        expiresAt: { $gt: new Date() },
    });
}

// Used specifically for reuse-detection: was this raw token issued at
// some point, REGARDLESS of current revoked/expired state? A hit here
// combined with revoked: true is the signal an already-rotated token is
// being presented again - see RefreshToken.model.js's replacedByTokenId
// comment for the future hardening this enables.
async function findAnyByRawToken(rawToken) {
    const tokenHash = RefreshToken.hashToken(rawToken);
    return RefreshToken.findOne({ tokenHash });
}

// ── Updates ──────────────────────────────────────────────────────────

async function revokeById(tokenId) {
    return RefreshToken.findByIdAndUpdate(tokenId, { revoked: true }, { new: true });
}

async function revokeAllForUser(userId) {
    const result = await RefreshToken.updateMany({ userId, revoked: false }, { revoked: true });
    return result.modifiedCount;
}

// Revoke-old + create-new + link them, as a single operation. This is
// exactly the sequence tested manually in File 37 - centralized here so
// the service layer calls one function instead of coordinating three
// separate repository calls itself.
async function rotate(oldTokenDoc, newRawToken, newExpiresAt, meta) {
    const newRecord = await create(oldTokenDoc.userId, newRawToken, newExpiresAt, meta);

    oldTokenDoc.revoked = true;
    oldTokenDoc.replacedByTokenId = newRecord._id;
    await oldTokenDoc.save();

    return newRecord;
}

module.exports = {
    create,
    findValidByRawToken,
    findAnyByRawToken,
    revokeById,
    revokeAllForUser,
    rotate,
};