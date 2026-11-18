'use strict';

const mongoose = require('mongoose');

const mfaChallengeSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    challengeHash: {
        type: String,
        required: true,
        unique: true,
    },
    codeHash: {
        type: String,
        required: true,
        select: false,
    },
    purpose: {
        type: String,
        enum: ['login', 'enable_email_mfa', 'disable_email_mfa'],
        required: true,
    },
    expiresAt: {
        type: Date,
        required: true,
    },
    consumedAt: {
        type: Date,
        default: null,
    },
    attempts: {
        type: Number,
        default: 0,
    },
}, {
    timestamps: true,
});

mfaChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
mfaChallengeSchema.index({ userId: 1, purpose: 1, consumedAt: 1 });

module.exports = mongoose.model('MfaChallenge', mfaChallengeSchema);
