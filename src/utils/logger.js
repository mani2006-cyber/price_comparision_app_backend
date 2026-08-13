// src/utils/logger.js
//
// Centralized logger. Every other module logs through this file instead
// of calling console.* or pino directly, so log format and behavior
// (e.g. what happens in production) is controlled in exactly one place.
// Backed by pino - every call site elsewhere in the app keeps using the
// same info/warn/error/debug(message, data) shape this module always
// exported, so switching the implementation here required zero changes
// anywhere else.

'use strict';

const pino = require('pino');
const config = require('../config/env');

// Pretty, colorized single-line output ONLY in real interactive
// development (`npm run dev` / `npm start` locally) - NOT in 'test'.
// pino-pretty runs its formatting in a worker thread; spinning that up
// fresh per Jest test file (each test file is its own process) adds
// real startup overhead and non-deterministic ordering with jest's own
// output for no benefit, since nobody is reading test-run logs as a
// human console stream the way they'd read a dev server's. Plain JSON
// lines (pino's default) in 'test' and 'production' alike - fast, and
// still exactly what a real log aggregator would want in production.
const usePrettyTransport = config.env === 'development';

const pinoLogger = pino({
    // 'debug' everywhere except production, matching the previous
    // module's own isProduction gate on debug() - now enforced by pino's
    // level filtering itself instead of an if-check in this file.
    level: config.isProduction ? 'info' : 'debug',
    transport: usePrettyTransport ? {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
    } : undefined,
});

// Errors don't serialize usefully by default (you get "{}" or a huge
// noisy object with circular refs). Pull out just the useful bits -
// same normalization the previous console-based implementation did, so
// output shape callers already depend on (e.g. { message, stack }) is
// unchanged.
function normalizeMetadata(data) {
    if (data === undefined || data === null) {
        return undefined;
    }

    if (data instanceof Error) {
        return { message: data.message, stack: data.stack };
    }

    // If metadata contains an Error nested inside (a common pattern:
    // logger.error("X failed", { message: err.message })), leave it as-is —
    // callers already extract what they need in that case.
    return data;
}

// pino's call shape is (mergingObject, message) - metadata first,
// message second, the reverse of this module's own (message, data)
// contract - so every level function here just flips the argument
// order rather than changing every call site across the app.
function write(pinoMethod, message, data) {
    const meta = normalizeMetadata(data);

    if (meta !== undefined) {
        pinoMethod.call(pinoLogger, meta, message);
    } else {
        pinoMethod.call(pinoLogger, message);
    }
}

function info(message, data) {
    write(pinoLogger.info, message, data);
}

function warn(message, data) {
    write(pinoLogger.warn, message, data);
}

function error(message, data) {
    write(pinoLogger.error, message, data);
}

// Silent unless NODE_ENV !== 'production' - enforced by pinoLogger's own
// level above, not a manual check here anymore. Use this for noisy,
// investigation-only logs (e.g. "cache miss for key X") that would just
// be clutter in a production log stream.
function debug(message, data) {
    write(pinoLogger.debug, message, data);
}

module.exports = { info, warn, error, debug };
