'use strict';
const rateLimit = require('express-rate-limit');

const json = (message) => ({ error: { code: 'RATE_LIMITED', message } });
const loginLimiter = rateLimit({ windowMs: 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, message: json('Too many login attempts') });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 600, standardHeaders: true, legacyHeaders: false, message: json('Too many requests') });
// Ingestion is machine traffic: generous but bounded (an agent sends ~1 batch/second).
const ingestLimiter = rateLimit({ windowMs: 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false, message: json('Ingestion rate exceeded') });

module.exports = { loginLimiter, apiLimiter, ingestLimiter };
