// tests/integration/middleware/rateLimiter.middleware.test.js
//
// Confirms the app-wide rate limiter (apiLimiter, rateLimiter.middleware.js)
// is actually wired into app.js. This used to be commented out entirely
// (`//app.use(apiLimiter);`) - meaning nothing stopped unlimited requests
// against any route. .env.test's RATE_LIMIT_MAX is set generously high
// (1000/window) specifically so the rest of the test suite's own request
// volume never trips this - this file is the one place that deliberately
// lowers it to prove the limiter is live, using a fresh require of both
// config and app (jest.resetModules()) rather than mutating the real
// .env.test values every other test file relies on.

'use strict';

const request = require('supertest');

function loadAppWithLowLimit(max) {
    jest.resetModules();
    const config = require('../../../src/config/env');
    config.rateLimit.windowMs = 60000;
    config.rateLimit.max = max;
    return require('../../../src/app');
}

describe('global rate limiter (apiLimiter, applied in app.js)', function() {
    it('allows requests up to the configured max', async function() {
        const app = loadAppWithLowLimit(3);

        for (let i = 0; i < 3; i++) {
            const res = await request(app).get('/health');
            expect(res.status).toBe(200);
        }
    });

    it('rejects the request after the configured max is exceeded, with a clean 429 body', async function() {
        const app = loadAppWithLowLimit(2);

        await request(app).get('/health');
        await request(app).get('/health');
        const res = await request(app).get('/health');

        expect(res.status).toBe(429);
        expect(res.body).toMatchObject({ success: false });
        expect(res.body.error).toContain('Too many requests');
    });

    it('sets standard RateLimit-* headers, not the legacy X-RateLimit-* ones', async function() {
        const app = loadAppWithLowLimit(5);

        const res = await request(app).get('/health');

        expect(res.headers['ratelimit-limit']).toBeDefined();
        expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    });
});
