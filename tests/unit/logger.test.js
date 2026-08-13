// tests/unit/logger.test.js
//
// Unit tests for logger.js's own contract - info/warn/error/debug
// (message, data), with an Error passed as `data` normalized to
// { message, stack } - independent of pino's real behavior (pino has
// its own test suite for that; this only tests THIS file's wrapper
// logic). 'pino' itself is mocked: pino writes via a raw file
// descriptor (SonicBoom), never through process.stdout.write(), so
// spying on stdout to capture real output is unreliable - mocking the
// library and asserting the correct pino method was called with the
// correct (mergingObject, message) argument order is the same approach
// already used for the BullMQ queue wiring tests.

'use strict';

const mockPinoLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
};

jest.mock('pino', function() {
    return jest.fn(function() { return mockPinoLogger; });
});

const logger = require('../../src/utils/logger');

beforeEach(function() {
    jest.clearAllMocks();
});

describe('logger', function() {
    it('info(message) with no data calls pino.info(message) - message only, no merging object', function() {
        logger.info('just a message');
        expect(mockPinoLogger.info).toHaveBeenCalledWith('just a message');
    });

    it('info(message, data) calls pino.info(data, message) - pino\'s own (mergingObject, msg) order', function() {
        logger.info('search finished', { query: 'laptop', count: 3 });
        expect(mockPinoLogger.info).toHaveBeenCalledWith({ query: 'laptop', count: 3 }, 'search finished');
    });

    it('warn() and error() route to their own pino methods, not info()', function() {
        logger.warn('careful');
        logger.error('broken');

        expect(mockPinoLogger.warn).toHaveBeenCalledWith('careful');
        expect(mockPinoLogger.error).toHaveBeenCalledWith('broken');
        expect(mockPinoLogger.info).not.toHaveBeenCalled();
    });

    it('debug() routes to pino.debug()', function() {
        logger.debug('noisy detail', { x: 1 });
        expect(mockPinoLogger.debug).toHaveBeenCalledWith({ x: 1 }, 'noisy detail');
    });

    it('normalizes an Error passed as data into { message, stack }', function() {
        const err = new Error('boom');
        logger.error('operation failed', err);

        const [meta, message] = mockPinoLogger.error.mock.calls[0];
        expect(message).toBe('operation failed');
        expect(meta.message).toBe('boom');
        expect(typeof meta.stack).toBe('string');
        expect(meta.stack).toContain('Error: boom');
        // The raw Error object itself is never forwarded as-is - pino's
        // own default error serialization is bypassed in favor of this
        // module's pre-existing normalization, unchanged from before pino.
        expect(meta).not.toBeInstanceOf(Error);
    });

    it('leaves a plain metadata object with a nested Error-shaped field untouched (only a top-level Error is unwrapped)', function() {
        logger.error('X failed', { message: 'inner message', code: 'ERR_X' });
        expect(mockPinoLogger.error).toHaveBeenCalledWith({ message: 'inner message', code: 'ERR_X' }, 'X failed');
    });

    it('treats null/undefined data the same as omitted data', function() {
        logger.info('msg', undefined);
        logger.info('msg', null);

        expect(mockPinoLogger.info).toHaveBeenNthCalledWith(1, 'msg');
        expect(mockPinoLogger.info).toHaveBeenNthCalledWith(2, 'msg');
    });
});
