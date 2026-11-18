// tests/integration/services/auth.service.test.js
//
// Integration test for auth.service.js - the most security-critical
// file in the suite. Covers signup, login, refresh rotation, reuse-
// detection (a stolen/replayed token revokes the ENTIRE session chain),
// and logout. Real User + RefreshToken documents, no mocking - this
// service's whole point is DB-backed revocation, which can't be
// meaningfully tested against a mock.

'use strict';

jest.mock('../../../src/services/email.service', function() {
    return {
        isConfigured: jest.fn(function() { return true; }),
        assertConfigured: jest.fn(),
        sendMfaCode: jest.fn().mockResolvedValue(undefined),
        sendPasswordResetCode: jest.fn().mockResolvedValue(undefined),
    };
});

const mongoose = require('mongoose');
const config = require('../../../src/config/env');
const User = require('../../../src/models/User.model');
const RefreshToken = require('../../../src/models/RefreshToken.model');
const MfaChallenge = require('../../../src/models/MfaChallenge.model');
const PasswordResetToken = require('../../../src/models/PasswordResetToken.model');
const authService = require('../../../src/services/auth.service');
const emailService = require('../../../src/services/email.service');
const logger = require('../../../src/utils/logger');
const ApiError = require('../../../src/utils/ApiError');

const TEST_EMAIL = 'svctest-auth@example.com';

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

describe('signup', function() {
    it('creates a user and returns both an accessToken and a refreshToken', async function() {
        const result = await authService.signup('Auth Test', TEST_EMAIL, 'plaintext123', { ip: '127.0.0.1' });

        expect(typeof result.accessToken).toBe('string');
        expect(typeof result.refreshToken).toBe('string');
        expect(result.accessToken).not.toBe(result.refreshToken);
        // .password is still present on the raw in-memory document -
        // toJSON only strips it on SERIALIZATION (JSON.stringify / res.json),
        // which is what actually happens over HTTP. Check the serialized
        // form here, matching what a real API response would show.
        const serializedUser = JSON.parse(JSON.stringify(result.user));
        expect(serializedUser.password).toBeUndefined();
    });

    it('rejects signup with an email that is already registered', async function() {
        await authService.signup('Auth Test', TEST_EMAIL, 'plaintext123', {});

        await expect(authService.signup('Duplicate', TEST_EMAIL, 'whatever123', {})).rejects.toMatchObject({
            statusCode: 409,
        });
    });

    it('persists a real RefreshToken record tied to the new user', async function() {
        const result = await authService.signup('Auth Test', TEST_EMAIL, 'plaintext123', {});

        const record = await RefreshToken.findOne({ userId: result.user._id });
        expect(record).not.toBeNull();
        expect(record.revoked).toBe(false);
    });
});

describe('login', function() {
    describe('email MFA', function() {
        it('requires a one-time email challenge before issuing a session', async function() {
            const signup = await authService.signup('Auth Test', TEST_EMAIL, 'plaintext123', {});
            await User.updateOne({ _id: signup.user._id }, { emailMfaEnabled: true });

            const login = await authService.login(TEST_EMAIL, 'plaintext123', { ip: '127.0.0.1' });
            expect(login.mfaRequired).toBe(true);
            expect(login.accessToken).toBeUndefined();
            expect(login.refreshToken).toBeUndefined();
            expect(emailService.sendMfaCode).toHaveBeenCalledTimes(1);

            const code = emailService.sendMfaCode.mock.calls[0][1];
            const completed = await authService.completeLoginMfa(login.challengeToken, code, {});
            expect(typeof completed.accessToken).toBe('string');
            expect(typeof completed.refreshToken).toBe('string');

            await expect(authService.completeLoginMfa(login.challengeToken, code, {})).rejects.toMatchObject({
                statusCode: 401,
            });
        });

        it('limits incorrect OTP attempts and does not accept a later correct code', async function() {
            const signup = await authService.signup('Auth Test', TEST_EMAIL, 'plaintext123', {});
            await User.updateOne({ _id: signup.user._id }, { emailMfaEnabled: true });

            const login = await authService.login(TEST_EMAIL, 'plaintext123', {});
            const code = emailService.sendMfaCode.mock.calls[0][1];
            const invalidCode = code === '000000' ? '000001' : '000000';

            for (let attempt = 0; attempt < 5; attempt++) {
                await expect(authService.completeLoginMfa(login.challengeToken, invalidCode, {})).rejects.toMatchObject({
                    statusCode: 401,
                });
            }
            await expect(authService.completeLoginMfa(login.challengeToken, code, {})).rejects.toMatchObject({
                statusCode: 401,
            });
        });

        it('invalidates an earlier login challenge when a newer OTP is issued', async function() {
            const signup = await authService.signup('Auth Test', TEST_EMAIL, 'plaintext123', {});
            await User.updateOne({ _id: signup.user._id }, { emailMfaEnabled: true });

            const firstChallenge = await authService.login(TEST_EMAIL, 'plaintext123', {});
            const firstCode = emailService.sendMfaCode.mock.calls[0][1];
            const secondChallenge = await authService.login(TEST_EMAIL, 'plaintext123', {});
            const secondCode = emailService.sendMfaCode.mock.calls[1][1];

            await expect(authService.completeLoginMfa(firstChallenge.challengeToken, firstCode, {})).rejects.toMatchObject({
                statusCode: 401,
            });
            await expect(authService.completeLoginMfa(secondChallenge.challengeToken, secondCode, {}))
                .resolves.toMatchObject({ user: expect.any(Object) });
        });
    });

    describe('password security operations', function() {
        it('changes the password, audits the operation, and revokes refresh sessions', async function() {
            const signup = await authService.signup('Auth Test', TEST_EMAIL, 'plaintext123', {});

            await authService.changePassword(signup.user._id, 'plaintext123', 'newpassword123', { ip: '127.0.0.1' });

            await expect(authService.login(TEST_EMAIL, 'plaintext123', {})).rejects.toMatchObject({ statusCode: 401 });
            expect((await authService.login(TEST_EMAIL, 'newpassword123', {})).accessToken).toBeTruthy();
            await expect(authService.refreshAccessToken(signup.refreshToken, {})).rejects.toMatchObject({ statusCode: 401 });
        });

        it('sends a one-time reset OTP, changes the password, and invalidates sessions', async function() {
            const signup = await authService.signup('Auth Test', TEST_EMAIL, 'plaintext123', {});
            await authService.requestPasswordReset(TEST_EMAIL, { ip: '127.0.0.1' });

            expect(emailService.sendPasswordResetCode).toHaveBeenCalledTimes(1);
            const otp = emailService.sendPasswordResetCode.mock.calls[0][1];
            expect(otp).toMatch(/^\d{6}$/);
            const resetRecord = await PasswordResetToken.findOne({ userId: signup.user._id });
            expect(resetRecord.tokenHash).not.toBe(otp);
            expect(resetRecord.codeSalt).toBeTruthy();

            await authService.completePasswordReset(TEST_EMAIL, otp, 'recovered123', { ip: '127.0.0.1' });

            await expect(authService.login(TEST_EMAIL, 'plaintext123', {})).rejects.toMatchObject({ statusCode: 401 });
            expect((await authService.login(TEST_EMAIL, 'recovered123', {})).accessToken).toBeTruthy();
            await expect(authService.refreshAccessToken(signup.refreshToken, {})).rejects.toMatchObject({ statusCode: 401 });
            await expect(authService.completePasswordReset(TEST_EMAIL, otp, 'another123', {})).rejects.toMatchObject({ statusCode: 401 });
        });

        it('expires a reset OTP after five incorrect attempts', async function() {
            await authService.signup('Auth Test', TEST_EMAIL, 'plaintext123', {});
            await authService.requestPasswordReset(TEST_EMAIL, {});

            const otp = emailService.sendPasswordResetCode.mock.calls[0][1];
            const invalidOtp = otp === '000000' ? '000001' : '000000';
            for (let attempt = 0; attempt < 5; attempt++) {
                await expect(authService.completePasswordReset(TEST_EMAIL, invalidOtp, 'recovered123', {}))
                    .rejects.toMatchObject({ statusCode: 401 });
            }

            await expect(authService.completePasswordReset(TEST_EMAIL, otp, 'recovered123', {}))
                .rejects.toMatchObject({ statusCode: 401 });
            expect((await authService.login(TEST_EMAIL, 'plaintext123', {})).accessToken).toBeTruthy();
        });

        it('invalidates an earlier reset OTP when a newer one is issued', async function() {
            await authService.signup('Auth Test', TEST_EMAIL, 'plaintext123', {});
            await authService.requestPasswordReset(TEST_EMAIL, {});
            const firstOtp = emailService.sendPasswordResetCode.mock.calls[0][1];

            await authService.requestPasswordReset(TEST_EMAIL, {});
            const secondOtp = emailService.sendPasswordResetCode.mock.calls[1][1];

            await expect(authService.completePasswordReset(TEST_EMAIL, firstOtp, 'recovered123', {}))
                .rejects.toMatchObject({ statusCode: 401 });
            await expect(authService.completePasswordReset(TEST_EMAIL, secondOtp, 'recovered123', {}))
                .resolves.toMatchObject({ success: true });
        });

        it('rejects a reset OTP after its expiration time', async function() {
            const signup = await authService.signup('Auth Test', TEST_EMAIL, 'plaintext123', {});
            await authService.requestPasswordReset(TEST_EMAIL, {});
            const otp = emailService.sendPasswordResetCode.mock.calls[0][1];

            await PasswordResetToken.updateMany({ userId: signup.user._id }, {
                $set: { expiresAt: new Date(Date.now() - 1000) },
            });

            await expect(authService.completePasswordReset(TEST_EMAIL, otp, 'recovered123', {}))
                .rejects.toMatchObject({ statusCode: 401 });
            expect((await authService.login(TEST_EMAIL, 'plaintext123', {})).accessToken).toBeTruthy();
        });
    });

    describe('security audit events', function() {
        it('records login, logout, password change, and account recovery without tokens or email addresses', async function() {
            const securityLog = jest.spyOn(logger, 'security').mockImplementation(function() {});
            const signup = await authService.signup('Auth Test', TEST_EMAIL, 'plaintext123', {});

            await authService.login(TEST_EMAIL, 'plaintext123', { ip: '127.0.0.1', userAgent: 'test-agent' });
            await authService.logout(signup.refreshToken, { ip: '127.0.0.1', userAgent: 'test-agent' });
            await authService.changePassword(signup.user._id, 'plaintext123', 'newpassword123', { ip: '127.0.0.1' });
            await authService.requestPasswordReset(TEST_EMAIL, { ip: '127.0.0.1' });
            const otp = emailService.sendPasswordResetCode.mock.calls[0][1];
            await authService.completePasswordReset(TEST_EMAIL, otp, 'recovered123', { ip: '127.0.0.1' });

            const messages = securityLog.mock.calls.map(function(call) { return call[0]; });
            expect(messages).toEqual(expect.arrayContaining([
                'Authentication succeeded',
                'Session logged out',
                'Password changed',
                'Account recovery requested',
                'Account recovery completed',
            ]));
            expect(JSON.stringify(securityLog.mock.calls)).not.toContain(TEST_EMAIL);
            expect(JSON.stringify(securityLog.mock.calls)).not.toContain(signup.refreshToken);
            securityLog.mockRestore();
        });
    });

    describe('password authentication', function() {
        beforeEach(async function() {
            await authService.signup('Auth Test', TEST_EMAIL, 'plaintext123', {});
        });

        it('succeeds with correct credentials', async function() {
            const result = await authService.login(TEST_EMAIL, 'plaintext123', {});
            expect(typeof result.accessToken).toBe('string');
        });

        it('rejects the wrong password with a generic message', async function() {
            await expect(authService.login(TEST_EMAIL, 'wrongpassword', {})).rejects.toMatchObject({
                statusCode: 401,
                message: 'Invalid email or password',
            });
        });

        it('rejects a non-existent email with the SAME generic message (no enumeration)', async function() {
            let caught;
            try {
                await authService.login('doesnotexist-' + TEST_EMAIL, 'whatever', {});
            } catch (err) {
                caught = err;
            }

            expect(caught).toBeInstanceOf(ApiError);
            expect(caught.statusCode).toBe(401);
            expect(caught.message).toBe('Invalid email or password');
        });
    });
});

describe('refreshAccessToken - rotation', function() {
    it('issues a NEW token pair and invalidates the old refresh token', async function() {
        const signupResult = await authService.signup('Auth Test', TEST_EMAIL, 'plaintext123', {});

        const refreshResult = await authService.refreshAccessToken(signupResult.refreshToken, {});

        expect(refreshResult.accessToken).not.toBe(signupResult.accessToken);
        expect(refreshResult.refreshToken).not.toBe(signupResult.refreshToken);
    });

    it('rejects reuse of the OLD token after it has been rotated', async function() {
        const signupResult = await authService.signup('Auth Test', TEST_EMAIL, 'plaintext123', {});
        await authService.refreshAccessToken(signupResult.refreshToken, {});

        await expect(authService.refreshAccessToken(signupResult.refreshToken, {})).rejects.toMatchObject({
            statusCode: 401,
        });
    });

    it('rejects a malformed/garbage token', async function() {
        await expect(authService.refreshAccessToken('not-a-real-jwt', {})).rejects.toMatchObject({
            statusCode: 401,
        });
    });

    it('rejects when no token is provided at all', async function() {
        await expect(authService.refreshAccessToken(null, {})).rejects.toMatchObject({ statusCode: 401 });
    });
});

describe('refreshAccessToken - reuse detection (theft response)', function() {
    it('revokes the ENTIRE session chain when an already-rotated token is replayed', async function() {
        const signupResult = await authService.signup('Auth Test', TEST_EMAIL, 'plaintext123', {});
        const firstRefresh = await authService.refreshAccessToken(signupResult.refreshToken, {});

        // Replay the ORIGINAL (now-rotated-past) token - simulates a
        // stolen token being used after the legitimate user already moved on.
        await expect(authService.refreshAccessToken(signupResult.refreshToken, {})).rejects.toMatchObject({
            statusCode: 401,
        });

        // The newer token from firstRefresh should ALSO now be dead - proof
        // the theft response nuked the whole chain, not just the replayed one.
        await expect(authService.refreshAccessToken(firstRefresh.refreshToken, {})).rejects.toMatchObject({
            statusCode: 401,
        });
    });
});

describe('logout', function() {
    it('revokes the refresh token so it can no longer be used', async function() {
        const signupResult = await authService.signup('Auth Test', TEST_EMAIL, 'plaintext123', {});

        await authService.logout(signupResult.refreshToken);

        await expect(authService.refreshAccessToken(signupResult.refreshToken, {})).rejects.toMatchObject({
            statusCode: 401,
        });
    });

    it('does not throw when called with no token (idempotent no-op)', async function() {
        await expect(authService.logout(null)).resolves.toBeUndefined();
    });
});