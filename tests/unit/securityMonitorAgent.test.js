'use strict';

const originalEnv = {
    SECURITY_MONITOR_ENABLED: process.env.SECURITY_MONITOR_ENABLED,
    SECURITY_MONITOR_URL: process.env.SECURITY_MONITOR_URL,
    SECURITY_ENFORCE_BLOCKS: process.env.SECURITY_ENFORCE_BLOCKS,
    SERVICE_HMAC_SECRET: process.env.SERVICE_HMAC_SECRET,
    SECURITY_MONITOR_PEPPER: process.env.SECURITY_MONITOR_PEPPER,
};
const originalFetch = global.fetch;

process.env.SECURITY_MONITOR_ENABLED = 'true';
process.env.SECURITY_MONITOR_URL = 'http://monitor.example.test';
process.env.SECURITY_ENFORCE_BLOCKS = 'false';
process.env.SERVICE_HMAC_SECRET = 'test-hmac-secret-that-is-long-enough';
process.env.SECURITY_MONITOR_PEPPER = 'test-pepper-secret';

const agent = require('../../src/security/securityMonitorAgent');

afterEach(function() {
    global.fetch = originalFetch;
});

afterAll(function() {
    Object.keys(originalEnv).forEach(function(key) {
        if (originalEnv[key] === undefined) delete process.env[key];
        else process.env[key] = originalEnv[key];
    });
});

function installFetch() {
    const calls = [];
    global.fetch = jest.fn(async function(url, options) {
        calls.push({ url, options });
        return { ok: true, status: 200, json: async function() { return { accepted: 1 }; } };
    });
    return calls;
}

describe('security monitor agent', function() {
    it('sends login outcome with a keyed identifier hash, never the identifier', async function() {
        const calls = installFetch();
        agent.reportAuth({
            ip: '203.0.113.10',
            originalUrl: '/api/auth/login?redirect=private',
        }, 'failure', ' User@example.com ');

        await agent.flush();

        expect(calls).toHaveLength(1);
        const body = JSON.parse(calls[0].options.body.toString());
        expect(body.events[0]).toMatchObject({
            type: 'auth',
            outcome: 'failure',
            path: '/api/auth/login',
        });
        expect(body.events[0].accountHash).toMatch(/^[a-f0-9]{64}$/);
        expect(JSON.stringify(body)).not.toContain('User@example.com');
        expect(calls[0].options.headers['x-sm-signature']).toMatch(/^[a-f0-9]{64}$/);
    });

    it('records query-free access metadata when the response closes', async function() {
        const EventEmitter = require('events');
        const calls = installFetch();
        const req = {
            ip: '203.0.113.11',
            method: 'GET',
            originalUrl: '/api/products/abc?token=do-not-send',
            headers: { accept: 'application/json', 'user-agent': 'test-agent' },
            socket: {},
        };
        const res = new EventEmitter();
        res.statusCode = 404;
        const next = jest.fn();

        agent.middleware()(req, res, next);
        req.route = { path: '/products/:id' };
        req.baseUrl = '/api';
        res.emit('close');
        await agent.flush();

        expect(next).toHaveBeenCalledTimes(1);
        const body = JSON.parse(calls[0].options.body.toString());
        expect(body.events[0]).toMatchObject({
            type: 'access',
            path: '/api/products/abc',
            route: '/api/products/:id',
            routeMatched: true,
            status: 404,
            userAgent: 'test-agent',
        });
        expect(JSON.stringify(body)).not.toContain('do-not-send');
    });

    it('sends only the rejection category and hostname for a blocked URL', async function() {
        const calls = installFetch();
        agent.reportUrlRejected({
            ip: '203.0.113.12',
            originalUrl: '/api/compare-url?secret=query-value',
        }, 'ssrf_blocked', '169.254.169.254');

        await agent.flush();

        const body = JSON.parse(calls[0].options.body.toString());
        expect(body.events[0]).toMatchObject({
            type: 'url_rejected',
            reason: 'ssrf_blocked',
            host: '169.254.169.254',
            path: '/api/compare-url',
        });
        expect(JSON.stringify(body)).not.toContain('query-value');
    });
});
