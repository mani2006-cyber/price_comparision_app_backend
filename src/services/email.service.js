'use strict';

const nodemailer = require('nodemailer');
const config = require('../config/env');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

function isConfigured() {
    return !!(config.email.smtpHost && config.email.from);
}

function assertConfigured() {
    if (!isConfigured()) {
        throw ApiError.serviceUnavailable('Email delivery is not configured');
    }
}

function createTransporter() {
    assertConfigured();
    const options = {
        host: config.email.smtpHost,
        port: config.email.smtpPort,
        secure: config.email.smtpSecure,
    };

    if (config.email.smtpUsername && config.email.smtpPassword) {
        options.auth = {
            user: config.email.smtpUsername,
            pass: config.email.smtpPassword,
        };
    }

    return nodemailer.createTransport(options);
}

async function sendEmail(message) {
    assertConfigured();
    try {
        await createTransporter().sendMail(Object.assign({ from: config.email.from }, message));
    } catch (err) {
        logger.security('Email delivery failed', {
            errorCode: err.code || 'SMTP_ERROR',
            outcome: 'failure',
        }, 'error');
        throw ApiError.badGateway('Email delivery failed; please try again later');
    }
}

async function sendMfaCode(email, otp, purpose) {
    const descriptions = {
        login: 'complete your sign-in',
        enable_email_mfa: 'enable email verification on your account',
        disable_email_mfa: 'disable email verification on your account',
    };
    const description = descriptions[purpose];
    if (!description) {
        throw ApiError.internal('Unsupported email verification purpose');
    }

    return sendEmail({
        to: email,
        subject: 'Your one-time security code',
        text: 'Use this code to ' + description + ': ' + otp + '. It expires in 5 minutes. If you did not request this, ignore this email.',
    });
}

async function sendPasswordResetCode(email, otp) {
    return sendEmail({
        to: email,
        subject: 'Your password reset code',
        text: 'Use this code to reset your password: ' + otp +
            '. It expires in 5 minutes and can only be used once. If you did not request this, ignore this email.',
    });
}

module.exports = {
    isConfigured,
    assertConfigured,
    sendMfaCode,
    sendPasswordResetCode,
};
