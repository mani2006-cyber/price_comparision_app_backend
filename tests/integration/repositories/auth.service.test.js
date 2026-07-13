// tests/integration/services/auth.service.test.js
//
// Integration test for auth.service.js - the most security-critical
// file in the suite. Covers signup, login, refresh rotation, reuse-
// detection (a stolen/replayed token revokes the ENTIRE session chain),
// and logout. Real User + RefreshToken documents, no mocking - this
// service's whole point is DB-backed revocation, which can't be
// meaningfully tested against a mock.

'use strict';

const mongoose = require('mongoose');
const config = require('../../../src/config/env');
const User = require('../../../src/models/User.model');
const RefreshToken = require('../../../src/models/RefreshToken.model');
const authService = require('../../../src/services/auth.service');
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
        await User.deleteOne({ _id: existing._id });
    }
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
        expect(caught.message).toBe('Invalid email or password'); // identical to wrong-password case
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