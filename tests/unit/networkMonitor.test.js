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
            endpoint: 'marketplace.example/products',
            httpStatus: 201,
            outcome: 'success',
        }), 'info');

        logSpy.mockRestore();
    });

    it('returns a safe placeholder for malformed destinations', function() {
        expect(networkMonitor.getEndpoint({ url: 'https://[bad' })).toBe('[unparseable-url]');
    });
});
