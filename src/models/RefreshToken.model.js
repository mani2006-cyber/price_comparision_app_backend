// src/models/RefreshToken.model.js
//
// Stores a HASH of each issued refresh token (never the raw value),
// tied to a user, enabling revocation and rotation that a stateless JWT
// alone cannot provide. A TTL index auto-deletes expired documents -
// no cleanup job needed. replacedByTokenId tracks rotation chains for
// future reuse-detection hardening.

'use strict';

const mongoose = require('mongoose');
const crypto = require('crypto');

const refreshTokenSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    // SHA-256 hash of the raw refresh token - never store the raw value.
    // Fast hash is correct here (not bcrypt): this is a high-entropy
    // random token, not a low-entropy human password to slow-hash
    // against brute force.
    tokenHash: {
        type: String,
        required: true,
        unique: true,
    },
    expiresAt: {
        type: Date,
        required: true,
    },
    revoked: {
        type: Boolean,
        default: false,
    },
    // Set when this token is rotated out for a new one - builds an
    // auditable chain, enabling future "detect reuse of an already-
    // rotated token, revoke the whole chain" hardening.
    replacedByTokenId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'RefreshToken',
        default: null,
    },
    userAgent: {
        type: String,
        default: null,
    },
    ip: {
        type: String,
        default: null,
    },
}, {
    timestamps: true, // createdAt = when this token was issued
});

// TTL index - MongoDB automatically deletes documents once expiresAt has
// passed. expireAfterSeconds: 0 means "delete exactly at the time
// stored in expiresAt", not 0 seconds after creation.
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Matches the real lookup pattern: given a raw token from a cookie,
// hash it and find the matching, still-valid record.
refreshTokenSchema.index({ tokenHash: 1, revoked: 1 });

// ── Static helper: hash a raw token consistently ────────────────────
// Static (not instance) method since hashing happens BEFORE a document
// exists yet - both when creating a new token and when looking one up.
refreshTokenSchema.statics.hashToken = function(rawToken) {
    return crypto.createHash('sha256').update(rawToken).digest('hex');
};

const RefreshToken = mongoose.model('RefreshToken', refreshTokenSchema);

module.exports = RefreshToken;