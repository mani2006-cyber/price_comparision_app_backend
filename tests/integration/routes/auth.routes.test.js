// tests/integration/routes/auth.routes.test.js
//
// Route-level integration test using Supertest against the REAL app.js
// (File 57) - no port, no manual curl. Exercises the full real chain:
// routes -> middleware -> controllers -> services -> repositories ->
// real MongoDB. Uses supertest.agent() to persist the HttpOnly refresh
// cookie across requests, exactly like a real browser would.

'use strict';

const request = require('supertest');
const mongoose = require('mongoose');
const config = require('../../../src/config/env');
const User = require('../../../src/models/User.model');
const RefreshToken = require('../../../src/models/RefreshToken.model');
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
        await User.deleteOne({ _id: existing._id });
    }
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
        const res = await request(app).post('/api/auth/login').send({ email: TEST_EMAIL, password: 'wrongpassword' });

        expect(res.status).toBe(401);
        expect(res.body.error).toBe('Invalid email or password');
    });
});