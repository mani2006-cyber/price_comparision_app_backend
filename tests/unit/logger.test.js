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
    const mockPino = jest.fn(function() { return mockPinoLogger; });
    mockPino.stdTimeFunctions = { isoTime: function() { return ''; } };
    return mockPino;
});

const logger = require('../../src/utils/logger');

beforeEach(function() {
    jest.clearAllMocks();
});

describe('logger', function() {
    it('adds an application event type when no metadata is supplied', function() {
        logger.info('just a message');
        expect(mockPinoLogger.info).toHaveBeenCalledWith({ eventType: 'application' }, 'just a message');
    });

    it('info(message, data) calls pino.info(data, message) - pino\'s own (mergingObject, msg) order', function() {
        logger.info('search finished', { query: 'laptop', count: 3 });
        expect(mockPinoLogger.info).toHaveBeenCalledWith(
            { query: '[REDACTED]', count: 3, eventType: 'application' },
            'search finished'
        );
    });

    it('warn() and error() route to their own pino methods, not info()', function() {
        logger.warn('careful');
        logger.error('broken');

        expect(mockPinoLogger.warn).toHaveBeenCalledWith({ eventType: 'application' }, 'careful');
        expect(mockPinoLogger.error).toHaveBeenCalledWith({ eventType: 'error' }, 'broken');
        expect(mockPinoLogger.info).not.toHaveBeenCalled();
    });

    it('debug() routes to pino.debug()', function() {
        logger.debug('noisy detail', { x: 1 });
        expect(mockPinoLogger.debug).toHaveBeenCalledWith({ x: 1, eventType: 'application' }, 'noisy detail');
    });

    it('normalizes an Error passed as data into { message, stack }', function() {
        const err = new Error('boom');
        logger.error('operation failed', err);

        const [meta, message] = mockPinoLogger.error.mock.calls[0];
        expect(message).toBe('operation failed');
        expect(meta.message).toBe('boom');
        expect(typeof meta.stack).toBe('string');
        expect(meta.stack).toContain('Error: boom');
        expect(meta.eventType).toBe('error');
        // The raw Error object itself is never forwarded as-is - pino's
        // own default error serialization is bypassed in favor of this
        // module's pre-existing normalization, unchanged from before pino.
        expect(meta).not.toBeInstanceOf(Error);
    });

    it('leaves a plain metadata object with a nested Error-shaped field untouched (only a top-level Error is unwrapped)', function() {
        logger.error('X failed', { message: 'inner message', code: 'ERR_X' });
        expect(mockPinoLogger.error).toHaveBeenCalledWith(
            { message: 'inner message', code: 'ERR_X', eventType: 'error' },
            'X failed'
        );
    });

    it('redacts sensitive nested fields and tokens embedded in strings', function() {
        logger.info('request to https://example.test/?refresh_token=secret password=inline api_key=private', {
            user: { email: 'person@example.test', password: 'pass' },
            authorization: 'Bearer eyJabcdefgh.abcdefgh.abcdefgh',
        });

        const [meta, message] = mockPinoLogger.info.mock.calls[0];
        expect(meta.user.email).toBe('[REDACTED]');
        expect(meta.user.password).toBe('[REDACTED]');
        expect(meta.authorization).toBe('[REDACTED]');
        expect(message).not.toContain('secret');
        expect(message).not.toContain('inline');
        expect(message).not.toContain('private');
        expect(message).not.toContain('person@example.test');
    });

    it('writes security and access events with distinct event types', function() {
        logger.security('Login failed', { outcome: 'failure' }, 'warn');
        logger.access('HTTP request completed', { method: 'GET' });

        expect(mockPinoLogger.warn).toHaveBeenCalledWith(
            { outcome: 'failure', eventType: 'security' },
            'Login failed'
        );
        expect(mockPinoLogger.info).toHaveBeenCalledWith(
            { method: 'GET', eventType: 'access' },
            'HTTP request completed'
        );
    });

    it('treats null/undefined data the same as omitted data', function() {
        logger.info('msg', undefined);
        logger.info('msg', null);

        expect(mockPinoLogger.info).toHaveBeenNthCalledWith(1, { eventType: 'application' }, 'msg');
        expect(mockPinoLogger.info).toHaveBeenNthCalledWith(2, { eventType: 'application' }, 'msg');
    });
});
