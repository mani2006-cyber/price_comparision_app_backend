'use strict';

const crypto = require('crypto');
const logger = require('../utils/logger');

function getEndpoint(req) {
    const requestUrl = req.originalUrl || req.path || '/';
    return requestUrl.split('?')[0] || '/';
}

function getChunkSize(chunk, encoding) {
    if (Buffer.isBuffer(chunk)) {
        return chunk.length;
    }
    if (typeof chunk === 'string') {
        return Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : 'utf8');
    }
    if (ArrayBuffer.isView(chunk)) {
        return chunk.byteLength;
    }
    return 0;
}

function requestLog(req, res, next) {
    req.requestId = crypto.randomUUID();
    res.setHeader('X-Request-Id', req.requestId);

    const endpoint = getEndpoint(req);
    const requestTimestamp = new Date().toISOString();
    const startedAt = process.hrtime();
    let requestSizeBytes = 0;
    let responseSizeBytes = 0;
    let logged = false;

    if (typeof req.on === 'function') {
        req.on('data', function(chunk) {
            requestSizeBytes += getChunkSize(chunk);
        });
    }

    const originalWrite = res.write;
    if (typeof originalWrite === 'function') {
        res.write = function(chunk, encoding, callback) {
            responseSizeBytes += getChunkSize(chunk, encoding);
            return originalWrite.call(this, chunk, encoding, callback);
        };
    }

    const originalEnd = res.end;
    if (typeof originalEnd === 'function') {
        res.end = function(chunk, encoding, callback) {
            responseSizeBytes += getChunkSize(chunk, encoding);
            return originalEnd.call(this, chunk, encoding, callback);
        };
    }

    function writeAccessLog(completed) {
        if (logged) {
            return;
        }
        logged = true;

        const elapsed = process.hrtime(startedAt);
        const responseTimeMs = Math.round((elapsed[0] * 1000 + elapsed[1] / 1000000) * 100) / 100;

        logger.access('HTTP request completed', {
            requestId: req.requestId,
            direction: 'inbound',
            requestTimestamp: requestTimestamp,
            method: req.method,
            endpoint: endpoint,
            httpStatus: res.statusCode,
            responseTimeMs,
            sourceIp: req.ip || null,
            userAgent: req.headers && req.headers['user-agent'] || null,
            requestSizeBytes: requestSizeBytes,
            responseSizeBytes: responseSizeBytes,
            userId: req.userId ? String(req.userId) : null,
            completed,
        });
    }

    res.once('finish', function() {
        writeAccessLog(true);
    });
    res.once('close', function() {
        writeAccessLog(!!res.writableFinished);
    });

    next();
}

module.exports = requestLog;
