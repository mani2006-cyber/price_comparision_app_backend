'use strict';

const mongoose = require('mongoose');

const passwordResetTokenSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    tokenHash: {
        type: String,
        required: true,
        unique: true,
    },
    codeSalt: {
        type: String,
        required: true,
    },
    expiresAt: {
        type: Date,
        required: true,
    },
    attempts: {
        type: Number,
        default: 0,
    },
    consumedAt: {
        type: Date,
        default: null,
    },
}, {
    timestamps: true,
});

passwordResetTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
passwordResetTokenSchema.index({ userId: 1, consumedAt: 1, expiresAt: 1 });

module.exports = mongoose.model('PasswordResetToken', passwordResetTokenSchema);
