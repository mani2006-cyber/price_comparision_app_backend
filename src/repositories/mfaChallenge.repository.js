'use strict';

const crypto = require('crypto');
const config = require('../config/env');
const MfaChallenge = require('../models/MfaChallenge.model');

const MAX_ATTEMPTS = 5;

function hashChallengeToken(rawToken) {
    return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function hashCode(userId, purpose, code) {
    return crypto.createHmac('sha256', config.refreshToken.secret)
        .update(userId.toString() + ':' + purpose + ':' + code)
        .digest('hex');
}

async function create(userId, rawToken, code, purpose, expiresAt) {
    return MfaChallenge.create({
        userId,
        challengeHash: hashChallengeToken(rawToken),
        codeHash: hashCode(userId, purpose, code),
        purpose,
        expiresAt,
    });
}

async function invalidateActiveForUser(userId, purpose) {
    return MfaChallenge.updateMany({
        userId,
        purpose,
        consumedAt: null,
    }, {
        $set: { consumedAt: new Date() },
    });
}

async function findValidByRawToken(rawToken) {
    return MfaChallenge.findOne({
        challengeHash: hashChallengeToken(rawToken),
        consumedAt: null,
        expiresAt: { $gt: new Date() },
        attempts: { $lt: MAX_ATTEMPTS },
    }).select('+codeHash');
}

async function incrementFailedAttempt(rawToken) {
    return MfaChallenge.updateOne({
        challengeHash: hashChallengeToken(rawToken),
        consumedAt: null,
        expiresAt: { $gt: new Date() },
        attempts: { $lt: MAX_ATTEMPTS },
    }, { $inc: { attempts: 1 } });
}

async function consume(rawToken, userId, purpose, code) {
    return MfaChallenge.findOneAndUpdate({
        challengeHash: hashChallengeToken(rawToken),
        userId,
        purpose,
        codeHash: hashCode(userId, purpose, code),
        consumedAt: null,
        expiresAt: { $gt: new Date() },
        attempts: { $lt: MAX_ATTEMPTS },
    }, {
        $set: { consumedAt: new Date() },
    }, {
        new: true,
    });
}

async function deleteByRawToken(rawToken) {
    return MfaChallenge.deleteOne({ challengeHash: hashChallengeToken(rawToken) });
}

module.exports = {
    MAX_ATTEMPTS,
    hashCode,
    create,
    invalidateActiveForUser,
    findValidByRawToken,
    incrementFailedAttempt,
    consume,
    deleteByRawToken,
};
