'use strict';

const crypto = require('crypto');
const config = require('../config/env');
const PasswordResetToken = require('../models/PasswordResetToken.model');

const MAX_ATTEMPTS = 5;

function hashCode(userId, salt, code) {
    return crypto.createHmac('sha256', config.refreshToken.secret)
        .update(userId.toString() + ':password_reset:' + salt + ':' + code)
        .digest('hex');
}

function hashesMatch(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string') {
        return false;
    }

    const leftBuffer = Buffer.from(left, 'hex');
    const rightBuffer = Buffer.from(right, 'hex');
    return leftBuffer.length === rightBuffer.length &&
        leftBuffer.length > 0 &&
        crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

async function invalidateForUser(userId) {
    return PasswordResetToken.updateMany({
        userId,
        consumedAt: null,
    }, {
        $set: { consumedAt: new Date() },
    });
}

async function create(userId, code, expiresAt) {
    const codeSalt = crypto.randomBytes(16).toString('hex');
    return PasswordResetToken.create({
        userId,
        tokenHash: hashCode(userId, codeSalt, code),
        codeSalt,
        expiresAt,
    });
}

async function consume(userId, code) {
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
        return null;
    }

    const record = await PasswordResetToken.findOne({
        userId,
        consumedAt: null,
        expiresAt: { $gt: new Date() },
        attempts: { $lt: MAX_ATTEMPTS },
        codeSalt: { $exists: true },
    }).sort({ createdAt: -1 });

    if (!record) {
        return null;
    }

    const suppliedHash = hashCode(userId, record.codeSalt, code);
    if (!hashesMatch(record.tokenHash, suppliedHash)) {
        await PasswordResetToken.updateOne({
            _id: record._id,
            consumedAt: null,
            expiresAt: { $gt: new Date() },
            attempts: { $lt: MAX_ATTEMPTS },
        }, {
            $inc: { attempts: 1 },
        });
        return null;
    }

    return PasswordResetToken.findOneAndUpdate({
        _id: record._id,
        userId,
        tokenHash: suppliedHash,
        consumedAt: null,
        expiresAt: { $gt: new Date() },
        attempts: { $lt: MAX_ATTEMPTS },
    }, {
        $set: { consumedAt: new Date() },
    }, {
        new: true,
    });
}

module.exports = { MAX_ATTEMPTS, invalidateForUser, create, consume };
