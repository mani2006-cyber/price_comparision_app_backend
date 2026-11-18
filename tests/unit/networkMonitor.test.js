'use strict';

const logger = require('../../src/utils/logger');
const networkMonitor = require('../../src/utils/networkMonitor');

describe('networkMonitor', function() {
    it('logs outbound HTTP metadata without query values', function() {
        const logSpy = jest.spyOn(logger, 'network').mockImplementation(function() {});
        const startedAt = process.hrtime();

        networkMonitor.logRequest({
            url: 'https://marketplace.example/products?id=private&token=secret',
            method: 'post',
            __networkMonitorStartedAt: startedAt,
        }, { status: 201 }, null);

        expect(logSpy).toHaveBeenCalledWith('Outbound HTTP request success', expect.objectContaining({
            direction: 'outbound',
            method: 'POST',
            destinationHostname: 'marketplace.example',
            endpoint: 'marketplace.example/products',
            httpStatus: 201,
            outcome: 'success',
        }), 'info');

        logSpy.mockRestore();
    });

    it('records outbound HTTP failures without logging the full URL or error message', function() {
        const logSpy = jest.spyOn(logger, 'network').mockImplementation(function() {});
        const error = Object.assign(new Error('request failed with token=secret'), { code: 'ECONNRESET' });

        networkMonitor.logRequest({
            url: 'https://user:password@marketplace.example/products?token=secret',
            method: 'get',
        }, { status: 503 }, error);

        expect(logSpy).toHaveBeenCalledWith('Outbound HTTP request failure', expect.objectContaining({
            direction: 'outbound',
            destinationHostname: 'marketplace.example',
            endpoint: 'marketplace.example/products',
            httpStatus: 503,
            outcome: 'failure',
            errorName: 'Error',
            errorCode: 'ECONNRESET',
        }), 'warn');
        expect(logSpy.mock.calls[0][1]).not.toHaveProperty('errorMessage');

        logSpy.mockRestore();
    });

    it('returns a safe placeholder for malformed destinations', function() {
        expect(networkMonitor.getEndpoint({ url: 'https://[bad' })).toBe('[unparseable-url]');
    });
});
