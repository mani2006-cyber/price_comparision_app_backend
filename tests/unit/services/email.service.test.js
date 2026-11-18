'use strict';

const nodemailer = require('nodemailer');
const config = require('../../../src/config/env');
const emailService = require('../../../src/services/email.service');

const originalEmailConfig = Object.assign({}, config.email);

afterEach(function() {
    jest.restoreAllMocks();
    Object.assign(config.email, originalEmailConfig);
});

describe('SMTP email delivery', function() {
    beforeEach(function() {
        config.email.smtpHost = 'smtp.example.test';
        config.email.smtpPort = 587;
        config.email.smtpSecure = false;
        config.email.smtpUsername = 'mailer-user';
        config.email.smtpPassword = 'mailer-password';
        config.email.from = 'no-reply@example.test';
    });

    it('sends an MFA code without including secrets in delivery metadata', async function() {
        const sendMail = jest.fn().mockResolvedValue({});
        const createTransport = jest.spyOn(nodemailer, 'createTransport').mockReturnValue({ sendMail });

        await emailService.sendMfaCode('user@example.test', '123456', 'login');

        expect(createTransport).toHaveBeenCalledWith({
            host: 'smtp.example.test',
            port: 587,
            secure: false,
            auth: { user: 'mailer-user', pass: 'mailer-password' },
        });
        expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
            from: 'no-reply@example.test',
            to: 'user@example.test',
            text: expect.stringContaining('123456'),
        }));
    });

    it('fails explicitly when SMTP is not configured', async function() {
        config.email.smtpHost = null;
        config.email.from = null;
        const createTransport = jest.spyOn(nodemailer, 'createTransport');

        await expect(emailService.sendPasswordResetCode('user@example.test', '123456'))
            .rejects.toMatchObject({ statusCode: 503 });
        expect(createTransport).not.toHaveBeenCalled();
    });

    it('sends a reset OTP instead of a reset link', async function() {
        const sendMail = jest.fn().mockResolvedValue({});
        jest.spyOn(nodemailer, 'createTransport').mockReturnValue({ sendMail });

        await emailService.sendPasswordResetCode('user@example.test', '123456');

        expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
            to: 'user@example.test',
            subject: 'Your password reset code',
            text: expect.stringContaining('123456'),
        }));
        expect(sendMail.mock.calls[0][0].text).not.toContain('http');
    });

    it('reports delivery failures rather than silently accepting them', async function() {
        jest.spyOn(nodemailer, 'createTransport').mockReturnValue({
            sendMail: jest.fn().mockRejectedValue(Object.assign(new Error('SMTP unavailable'), { code: 'ECONNECTION' })),
        });

        await expect(emailService.sendPasswordResetCode('user@example.test', '123456'))
            .rejects.toMatchObject({ statusCode: 502 });
    });
});
