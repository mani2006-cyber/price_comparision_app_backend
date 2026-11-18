'use strict';

const config = require('../config/env');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

async function verifyToken(token, sourceIp, expectedAction) {
    if (!config.turnstile.enabled) {
        return true;
    }

    if (typeof token !== 'string' || token.length === 0 || token.length > 2048) {
        return false;
    }

    const controller = new AbortController();
    const timeout = setTimeout(function() {
        controller.abort();
    }, config.turnstile.timeoutMs);

    let response;
    try {
        const body = new URLSearchParams({
            secret: config.turnstile.secretKey,
            response: token,
        });
        if (sourceIp) {
            body.set('remoteip', sourceIp);
        }

        response = await fetch(config.turnstile.verifyUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
            signal: controller.signal,
        });
    } catch (err) {
        logger.security('CAPTCHA verification unavailable', {
            sourceIp: sourceIp || null,
            errorCode: err.code || null,
            outcome: 'failure',
        }, 'error');
        throw ApiError.serviceUnavailable('CAPTCHA verification is unavailable');
    } finally {
        clearTimeout(timeout);
    }

    if (!response.ok) {
        logger.security('CAPTCHA verification unavailable', {
            sourceIp: sourceIp || null,
            providerStatus: response.status,
            outcome: 'failure',
        }, 'error');
        throw ApiError.serviceUnavailable('CAPTCHA verification is unavailable');
    }

    let result;
    try {
        result = await response.json();
    } catch (err) {
        logger.security('CAPTCHA provider returned an invalid response', {
            sourceIp: sourceIp || null,
            outcome: 'failure',
        }, 'error');
        throw ApiError.badGateway('CAPTCHA provider returned an invalid response');
    }

    return result.success === true && result.action === expectedAction;
}

module.exports = { verifyToken };
