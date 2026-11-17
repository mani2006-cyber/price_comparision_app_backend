'use strict';

const crypto = require('crypto');
const logger = require('../utils/logger');

function getEndpoint(req) {
    const requestUrl = req.originalUrl || req.path || '/';
    return requestUrl.split('?')[0] || '/';
}

function requestLog(req, res, next) {
    req.requestId = crypto.randomUUID();
    res.setHeader('X-Request-Id', req.requestId);

    const endpoint = getEndpoint(req);
    const startedAt = process.hrtime();
    let logged = false;

    function writeAccessLog(completed) {
        if (logged) {
            return;
        }
        logged = true;

        const elapsed = process.hrtime(startedAt);
        const responseTimeMs = Math.round((elapsed[0] * 1000 + elapsed[1] / 1000000) * 100) / 100;

        logger.access('HTTP request completed', {
            requestId: req.requestId,
            method: req.method,
            endpoint: endpoint,
            httpStatus: res.statusCode,
            responseTimeMs,
            sourceIp: req.ip || null,
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
