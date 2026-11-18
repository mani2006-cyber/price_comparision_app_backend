'use strict';

const axios = require('axios');
const securityMonitorAgent = require('../../../src/security/securityMonitorAgent');
const {
    MAX_REDIRECTS,
    MAX_RESPONSE_BYTES,
    isPublicAddress,
    createPublicLookup,
    safeGet,
} = require('../../../src/adapters/shared/safeMarketplaceRequest');

afterEach(function() {
    jest.restoreAllMocks();
});

describe('marketplace URL validation and DNS checks', function() {
    it.each([
        '10.0.0.1',
        '127.0.0.1',
        '169.254.10.20',
        '192.168.1.1',
        '::1',
        'fc00::1',
        'fe80::1',
        '::ffff:127.0.0.1',
    ])('blocks non-public address %s', function(address) {
        expect(isPublicAddress(address)).toBe(false);
    });

    it('accepts a public address', function() {
        expect(isPublicAddress('8.8.8.8')).toBe(true);
    });

    it('rejects a marketplace hostname that resolves to a private address', function(done) {
        const lookup = createPublicLookup(function(hostname, options, callback) {
            callback(null, [{ address: '127.0.0.1', family: 4 }]);
        });

        lookup('www.amazon.in', { all: true }, function(err, addresses) {
            expect(err).toMatchObject({ code: 'ERR_UNSAFE_DESTINATION' });
            expect(addresses).toBeUndefined();
            done();
        });
    });

    it('rejects mixed public and private DNS answers', function(done) {
        const lookup = createPublicLookup(function(hostname, options, callback) {
            callback(null, [
                { address: '8.8.8.8', family: 4 },
                { address: '10.0.0.1', family: 4 },
            ]);
        });

        lookup('www.amazon.in', { all: true }, function(err, addresses) {
            expect(err).toMatchObject({ code: 'ERR_UNSAFE_DESTINATION' });
            expect(addresses).toBeUndefined();
            done();
        });
    });

    it('uses the public DNS answer when every answer is public', function(done) {
        const lookup = createPublicLookup(function(hostname, options, callback) {
            callback(null, [{ address: '8.8.8.8', family: 4 }]);
        });

        lookup('www.amazon.in', {}, function(err, address, family) {
            expect(err).toBeNull();
            expect(address).toBe('8.8.8.8');
            expect(family).toBe(4);
            done();
        });
    });
});

describe('safeGet', function() {
    it('rejects unsupported, local, and malformed destinations before making a request', async function() {
        const get = jest.spyOn(axios, 'get');

        await expect(safeGet('http://www.amazon.in/dp/123')).rejects.toMatchObject({ statusCode: 400 });
        await expect(safeGet('ftp://www.amazon.in/dp/123')).rejects.toMatchObject({ statusCode: 400 });
        await expect(safeGet('https://www.amazon.in:8443/dp/123')).rejects.toMatchObject({ statusCode: 400 });
        await expect(safeGet('https://amazon.in.evil.example/dp/123')).rejects.toMatchObject({ statusCode: 400 });
        await expect(safeGet('https://127.0.0.1/')).rejects.toMatchObject({ statusCode: 400 });
        await expect(safeGet('https://localhost/')).rejects.toMatchObject({ statusCode: 400 });
        await expect(safeGet('https://user:pass@www.amazon.in/dp/123')).rejects.toMatchObject({ statusCode: 400 });

        expect(get).not.toHaveBeenCalled();
    });

    it.each([
        'https://evil.example/redirected',
        'http://www.amazon.in/redirected',
        'https://127.0.0.1/redirected',
    ])('blocks a redirect to unsupported destination %s', async function(location) {
        const get = jest.spyOn(axios, 'get').mockResolvedValue({
            status: 302,
            headers: { location },
        });

        await expect(safeGet('https://www.amazon.in/dp/123')).rejects.toMatchObject({ statusCode: 502 });
        expect(get).toHaveBeenCalledTimes(1);
    });

    it('revalidates each redirect, caps response size and timeout, and strips credentials across hosts', async function() {
        const get = jest.spyOn(axios, 'get')
            .mockResolvedValueOnce({
                status: 302,
                headers: { location: 'https://www.flipkart.com/item/123' },
            })
            .mockResolvedValueOnce({ status: 200, data: '<html>ok</html>' });

        const result = await safeGet('https://www.amazon.in/dp/123', {
            headers: { Cookie: 'session=secret', Authorization: 'Bearer secret' },
            timeout: 1234,
            maxContentLength: MAX_RESPONSE_BYTES * 2,
        });

        expect(result.data).toBe('<html>ok</html>');
        expect(get).toHaveBeenCalledTimes(2);
        expect(get.mock.calls[0][1]).toEqual(expect.objectContaining({
            maxRedirects: 0,
            proxy: false,
            timeout: 1234,
            maxContentLength: MAX_RESPONSE_BYTES,
        }));
        expect(get.mock.calls[0][1].httpsAgent.options.lookup).toEqual(expect.any(Function));
        expect(get.mock.calls[0][1].signal).toBeDefined();
        expect(get.mock.calls[1][1].headers).not.toHaveProperty('Cookie');
        expect(get.mock.calls[1][1].headers).not.toHaveProperty('Authorization');
    });

    it('stops after the configured redirect limit', async function() {
        const get = jest.spyOn(axios, 'get');
        for (let i = 0; i <= MAX_REDIRECTS; i++) {
            get.mockResolvedValueOnce({
                status: 302,
                headers: { location: '/next' },
            });
        }

        await expect(safeGet('https://www.amazon.in/dp/123')).rejects.toMatchObject({ statusCode: 502 });
        expect(get).toHaveBeenCalledTimes(MAX_REDIRECTS + 1);
    });

    it('reports a sanitized upstream failure without changing the thrown error', async function() {
        const error = Object.assign(new Error('upstream unavailable'), { code: 'ECONNRESET' });
        const get = jest.spyOn(axios, 'get').mockRejectedValue(error);
        const reportSpy = jest.spyOn(securityMonitorAgent, 'reportOutboundFailure').mockImplementation(function() {});

        await expect(safeGet('https://www.amazon.in/dp/private-token?key=private-value')).rejects.toBe(error);

        expect(reportSpy).toHaveBeenCalledWith(
            'https://www.amazon.in/dp/private-token?key=private-value',
            undefined,
            expect.any(Number),
            'ECONNRESET'
        );
    });
});
