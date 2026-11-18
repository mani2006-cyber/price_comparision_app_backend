// tests/integration/routes/auth.routes.test.js
//
// Route-level integration test using Supertest against the REAL app.js
// (File 57) - no port, no manual curl. Exercises the full real chain:
// routes -> middleware -> controllers -> services -> repositories ->
// real MongoDB. Uses supertest.agent() to persist the HttpOnly refresh
// cookie across requests, exactly like a real browser would.

'use strict';

jest.mock('../../../src/services/email.service', function() {
    return {
        isConfigured: jest.fn(function() { return true; }),
        assertConfigured: jest.fn(),
        sendMfaCode: jest.fn().mockResolvedValue(undefined),
        sendPasswordResetCode: jest.fn().mockResolvedValue(undefined),
    };
});

const request = require('supertest');
const mongoose = require('mongoose');
const config = require('../../../src/config/env');
const User = require('../../../src/models/User.model');
const RefreshToken = require('../../../src/models/RefreshToken.model');
const MfaChallenge = require('../../../src/models/MfaChallenge.model');
const PasswordResetToken = require('../../../src/models/PasswordResetToken.model');
const emailService = require('../../../src/services/email.service');
const securityMonitorAgent = require('../../../src/security/securityMonitorAgent');
const app = require('../../../src/app');

const TEST_EMAIL = 'routetest-auth@example.com';

beforeAll(async function() {
    await mongoose.connect(config.mongoUri);
});

afterAll(async function() {
    await mongoose.disconnect();
});

beforeEach(async function() {
    const existing = await User.findOne({ email: TEST_EMAIL });
    if (existing) {
        await RefreshToken.deleteMany({ userId: existing._id });
        await MfaChallenge.deleteMany({ userId: existing._id });
        await PasswordResetToken.deleteMany({ userId: existing._id });
        await User.deleteOne({ _id: existing._id });
    }
    emailService.assertConfigured.mockClear();
    emailService.sendMfaCode.mockReset().mockResolvedValue(undefined);
    emailService.sendPasswordResetCode.mockReset().mockResolvedValue(undefined);
});

describe('POST /api/auth/signup', function() {
    it('creates a user, returns 201 with accessToken, and sets an HttpOnly refresh cookie', async function() {
        const res = await request(app)
            .post('/api/auth/signup')
            .send({ name: 'Route Test', email: TEST_EMAIL, password: 'plaintext123' });

        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(typeof res.body.accessToken).toBe('string');
        expect(res.body.user.password).toBeUndefined();

        const cookieHeader = res.headers['set-cookie'].join(';');
        expect(cookieHeader).toContain('refreshToken=');
        expect(cookieHeader.toLowerCase()).toContain('httponly');
    });

    it('rejects a duplicate email with a 409', async function() {
        await request(app).post('/api/auth/signup').send({ name: 'First', email: TEST_EMAIL, password: 'plaintext123' });

        const res = await request(app)
            .post('/api/auth/signup')
            .send({ name: 'Duplicate', email: TEST_EMAIL, password: 'whatever123' });

        expect(res.status).toBe(409);
        expect(res.body.error).toBe('Email is already registered');
    });

    it('rejects a missing field with a 400', async function() {
        const res = await request(app).post('/api/auth/signup').send({ email: 'nofield@example.com' });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('name');
    });

    it('requires a valid Turnstile token when CAPTCHA is enabled', async function() {
        const previousEnabled = config.turnstile.enabled;
        const previousSiteKey = config.turnstile.siteKey;
        const previousSecretKey = config.turnstile.secretKey;
        config.turnstile.enabled = true;
        config.turnstile.siteKey = 'test-site-key';
        config.turnstile.secretKey = 'test-secret-key';

        try {
            const signup = await request(app)
                .post('/api/auth/signup')
                .send({ name: 'Route Test', email: TEST_EMAIL, password: 'plaintext123' });

            const login = await request(app)
                .post('/api/auth/login')
                .send({ email: TEST_EMAIL, password: 'plaintext123' });

            expect(signup.status).toBe(403);
            expect(login.status).toBe(403);
        } finally {
            config.turnstile.enabled = previousEnabled;
            config.turnstile.siteKey = previousSiteKey;
            config.turnstile.secretKey = previousSecretKey;
        }
    });
});

describe('full flow: signup -> refresh -> logout -> refresh again fails', function() {
    it('walks the entire cookie-based session lifecycle correctly', async function() {
        const agent = request.agent(app);

        // 1. Signup - agent captures the refresh cookie automatically
        const signupRes = await agent
            .post('/api/auth/signup')
            .send({ name: 'Route Test', email: TEST_EMAIL, password: 'plaintext123' });
        expect(signupRes.status).toBe(201);

        // 2. Refresh - agent automatically sends the captured cookie
        const refreshRes = await agent.post('/api/auth/refresh');
        expect(refreshRes.status).toBe(200);
        expect(refreshRes.body.accessToken).not.toBe(signupRes.body.accessToken);

        // 3. Logout - clears the cookie server-side AND revokes the DB record
        const logoutRes = await agent.post('/api/auth/logout');
        expect(logoutRes.status).toBe(200);

        // 4. Refresh again with the (now revoked) cookie the agent still has
        // queued from before logout cleared it - should fail
        const failedRefresh = await agent.post('/api/auth/refresh');
        expect(failedRefresh.status).toBe(401);
    });
});

describe('POST /api/auth/login', function() {
    beforeEach(async function() {
        await request(app).post('/api/auth/signup').send({ name: 'Route Test', email: TEST_EMAIL, password: 'plaintext123' });
    });

    it('succeeds with correct credentials', async function() {
        const res = await request(app).post('/api/auth/login').send({ email: TEST_EMAIL, password: 'plaintext123' });

        expect(res.status).toBe(200);
        expect(typeof res.body.accessToken).toBe('string');
    });

    it('rejects wrong credentials with a generic 401', async function() {
        const reportAuth = jest.spyOn(securityMonitorAgent, 'reportAuth');
        const res = await request(app).post('/api/auth/login').send({ email: TEST_EMAIL, password: 'wrongpassword' });

        expect(res.status).toBe(401);
        expect(res.body.error).toBe('Invalid email or password');
        expect(reportAuth).toHaveBeenCalledWith(expect.any(Object), 'failure', TEST_EMAIL);
        reportAuth.mockRestore();
    });

    it('reports a successful sign-in to the monitor', async function() {
        const reportAuth = jest.spyOn(securityMonitorAgent, 'reportAuth');
        const res = await request(app).post('/api/auth/login').send({ email: TEST_EMAIL, password: 'plaintext123' });

        expect(res.status).toBe(200);
        expect(reportAuth).toHaveBeenCalledWith(expect.any(Object), 'success', TEST_EMAIL);
        reportAuth.mockRestore();
    });
});

describe('security-monitor URL rejection events', function() {
    it('reports an unsupported comparison URL without forwarding its query string', async function() {
        const reportUrlRejected = jest.spyOn(securityMonitorAgent, 'reportUrlRejected');
        const res = await request(app)
            .post('/api/compare-url')
            .send({ url: 'https://example.com/product?private=value' });

        expect(res.status).toBe(400);
        expect(reportUrlRejected).toHaveBeenCalledWith(expect.any(Object), 'unsupported_marketplace', 'example.com');
        reportUrlRejected.mockRestore();
    });
});

describe('optional email MFA', function() {
    it('requires an email OTP after password login when MFA is enabled', async function() {
        await request(app).post('/api/auth/signup').send({ name: 'Route Test', email: TEST_EMAIL, password: 'plaintext123' });
        await User.updateOne({ email: TEST_EMAIL }, { emailMfaEnabled: true });

        const challenge = await request(app)
            .post('/api/auth/login')
            .send({ email: TEST_EMAIL, password: 'plaintext123' });

        expect(challenge.status).toBe(202);
        expect(challenge.body.mfaRequired).toBe(true);
        expect(challenge.body.accessToken).toBeUndefined();
        expect(challenge.headers['set-cookie']).toBeUndefined();
        expect(emailService.sendMfaCode).toHaveBeenCalledTimes(1);

        const otp = emailService.sendMfaCode.mock.calls[0][1];
        const completed = await request(app)
            .post('/api/auth/login/mfa')
            .send({ challengeToken: challenge.body.challengeToken, otp });

        expect(completed.status).toBe(200);
        expect(typeof completed.body.accessToken).toBe('string');
        expect(completed.headers['set-cookie'].join(';')).toContain('refreshToken=');

        const replay = await request(app)
            .post('/api/auth/login/mfa')
            .send({ challengeToken: challenge.body.challengeToken, otp });
        expect(replay.status).toBe(401);
    });

    it('requires password confirmation and OTP to enable email MFA', async function() {
        const signup = await request(app)
            .post('/api/auth/signup')
            .send({ name: 'Route Test', email: TEST_EMAIL, password: 'plaintext123' });

        const challenge = await request(app)
            .post('/api/auth/mfa/email/challenge')
            .set('Authorization', 'Bearer ' + signup.body.accessToken)
            .send({ password: 'plaintext123', action: 'enable' });

        expect(challenge.status).toBe(202);
        const otp = emailService.sendMfaCode.mock.calls[0][1];
        const verified = await request(app)
            .post('/api/auth/mfa/email/verify')
            .set('Authorization', 'Bearer ' + signup.body.accessToken)
            .send({ challengeToken: challenge.body.challengeToken, otp });

        expect(verified.status).toBe(200);
        expect(verified.body.emailMfaEnabled).toBe(true);
        expect((await User.findOne({ email: TEST_EMAIL })).emailMfaEnabled).toBe(true);
    });
});

describe('password change and recovery', function() {
    it('changes an authenticated user password and invalidates their refresh session', async function() {
        const signup = await request(app)
            .post('/api/auth/signup')
            .send({ name: 'Route Test', email: TEST_EMAIL, password: 'plaintext123' });

        const changed = await request(app)
            .post('/api/auth/password/change')
            .set('Authorization', 'Bearer ' + signup.body.accessToken)
            .send({ currentPassword: 'plaintext123', newPassword: 'newpassword123' });

        expect(changed.status).toBe(200);
        expect(changed.headers['set-cookie'].join(';')).toContain('refreshToken=');
        expect((await request(app).post('/api/auth/login').send({
            email: TEST_EMAIL,
            password: 'newpassword123',
        })).status).toBe(200);
        expect((await request(app).post('/api/auth/login').send({
            email: TEST_EMAIL,
            password: 'plaintext123',
        })).status).toBe(401);
    });

    it('keeps recovery responses generic and consumes a reset OTP once', async function() {
        await request(app).post('/api/auth/signup').send({ name: 'Route Test', email: TEST_EMAIL, password: 'plaintext123' });

        const requested = await request(app)
            .post('/api/auth/password/forgot')
            .send({ email: TEST_EMAIL });
        expect(requested.status).toBe(202);
        expect(requested.body.message).toContain('If an account exists');

        const otp = emailService.sendPasswordResetCode.mock.calls[0][1];
        expect(otp).toMatch(/^\d{6}$/);
        const reset = await request(app)
            .post('/api/auth/password/reset')
            .send({ email: TEST_EMAIL, otp, password: 'recovered123' });
        expect(reset.status).toBe(200);

        expect((await request(app).post('/api/auth/login').send({
            email: TEST_EMAIL,
            password: 'recovered123',
        })).status).toBe(200);

        const replay = await request(app)
            .post('/api/auth/password/reset')
            .send({ email: TEST_EMAIL, otp, password: 'another123' });
        expect(replay.status).toBe(401);

        const unknownAccount = await request(app)
            .post('/api/auth/password/forgot')
            .send({ email: 'unknown@example.com' });
        expect(unknownAccount.status).toBe(202);
        expect(unknownAccount.body.message).toBe(requested.body.message);
    });
});