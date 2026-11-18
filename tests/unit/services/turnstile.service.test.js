'use strict';

const config = require('../../../src/config/env');
const turnstileService = require('../../../src/services/turnstile.service');

const originalFetch = global.fetch;
const originalEnabled = config.turnstile.enabled;
const originalSecretKey = config.turnstile.secretKey;
const originalTimeoutMs = config.turnstile.timeoutMs;

afterEach(function() {
    global.fetch = originalFetch;
    config.turnstile.enabled = originalEnabled;
    config.turnstile.secretKey = originalSecretKey;
    config.turnstile.timeoutMs = originalTimeoutMs;
});

describe('verifyToken', function() {
    beforeEach(function() {
        config.turnstile.enabled = true;
        config.turnstile.secretKey = 'test-secret';
        config.turnstile.timeoutMs = 1000;
    });

    it('sends the token and source IP to Turnstile and checks the expected action', async function() {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async function() {
                return { success: true, action: 'login', hostname: 'localhost' };
            },
        });

        await expect(turnstileService.verifyToken('captcha-response', '203.0.113.1', 'login'))
            .resolves.toBe(true);

        const [url, options] = global.fetch.mock.calls[0];
        expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
        expect(options.method).toBe('POST');
        expect(options.body).toContain('secret=test-secret');
        expect(options.body).toContain('response=captcha-response');
        expect(options.body).toContain('remoteip=203.0.113.1');
    });

    it('rejects unsuccessful or wrong-action provider results', async function() {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async function() {
                return { success: true, action: 'signup', hostname: 'localhost' };
            },
        });

        await expect(turnstileService.verifyToken('captcha-response', null, 'login'))
            .resolves.toBe(false);
    });

    it('fails closed when the provider is unavailable', async function() {
        global.fetch = jest.fn().mockRejectedValue(new Error('network unavailable'));

        await expect(turnstileService.verifyToken('captcha-response', null, 'login'))
            .rejects.toMatchObject({ statusCode: 503 });
    });

    it('does not contact the provider when Turnstile is disabled', async function() {
        config.turnstile.enabled = false;
        global.fetch = jest.fn();

        await expect(turnstileService.verifyToken(null, null, 'login')).resolves.toBe(true);
        expect(global.fetch).not.toHaveBeenCalled();
    });
});
