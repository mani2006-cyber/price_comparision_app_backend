'use strict';

const EventEmitter = require('events');
const express = require('express');
const request = require('supertest');
const logger = require('../../../src/utils/logger');
const requestLog = require('../../../src/middleware/requestLog.middleware');

describe('requestLog middleware', function() {
    it('adds a request ID and logs normalized access details when the response finishes', function() {
        const logSpy = jest.spyOn(logger, 'access').mockImplementation(function() {});
        const req = {
            method: 'GET',
            baseUrl: '/api',
            path: '/api/products/123',
            originalUrl: '/api/products/123?sort=price',
            route: { path: '/products/:id' },
            ip: '127.0.0.1',
        };
        const res = new EventEmitter();
        res.statusCode = 200;
        res.setHeader = jest.fn();
        res.writableFinished = true;
        const next = jest.fn();

        requestLog(req, res, next);
        res.emit('finish');

        expect(req.requestId).toMatch(/^[0-9a-f-]{36}$/i);
        expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', req.requestId);
        expect(next).toHaveBeenCalled();
        expect(logSpy).toHaveBeenCalledWith('HTTP request completed', expect.objectContaining({
            requestId: req.requestId,
            method: 'GET',
            endpoint: '/api/products/123',
            httpStatus: 200,
            sourceIp: '127.0.0.1',
            completed: true,
        }));

        logSpy.mockRestore();
    });

    it('logs an endpoint without query parameters for unmatched paths', function() {
        const logSpy = jest.spyOn(logger, 'access').mockImplementation(function() {});
        const req = {
            method: 'GET',
            path: '/api/notifications/stream',
            originalUrl: '/api/notifications/stream?cursor=abc',
            ip: '127.0.0.1',
        };
        const res = new EventEmitter();
        res.statusCode = 404;
        res.setHeader = jest.fn();
        res.writableFinished = true;

        requestLog(req, res, jest.fn());
        res.emit('finish');

        expect(logSpy.mock.calls[0][1].endpoint).toBe('/api/notifications/stream');

        logSpy.mockRestore();
    });

    it('records request metadata and body byte counts on a real HTTP request', async function() {
        const logSpy = jest.spyOn(logger, 'access').mockImplementation(function() {});
        const app = express();
        app.use(requestLog);
        app.use(express.json());
        app.post('/echo', function(req, res) {
            req.userId = 'user-123';
            res.json({ ok: true });
        });

        const requestBody = { message: 'hello' };
        const responseBody = { ok: true };
        const response = await request(app)
            .post('/echo')
            .set('User-Agent', 'request-log-test/1.0')
            .send(requestBody);

        const logData = logSpy.mock.calls[0][1];
        expect(response.status).toBe(200);
        expect(logData).toEqual(expect.objectContaining({
            direction: 'inbound',
            requestTimestamp: expect.any(String),
            userAgent: 'request-log-test/1.0',
            requestSizeBytes: Buffer.byteLength(JSON.stringify(requestBody)),
            responseSizeBytes: Buffer.byteLength(JSON.stringify(responseBody)),
            userId: 'user-123',
        }));
        expect(Number.isNaN(Date.parse(logData.requestTimestamp))).toBe(false);

        logSpy.mockRestore();
    });
});
