// src/utils/logger.js
//
// Centralized logger. Every other module logs through this file instead
// of calling console.* directly, so log format and behavior (e.g. what
// happens in production) is controlled in exactly one place.

'use strict';

const config = require('../config/env');

function timestamp() {
    return new Date().toISOString();
}

// Errors don't stringify usefully by default (you get "{}" or a huge
// noisy object). Pull out just the useful bits.
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

function write(level, consoleMethod, message, data) {
    const meta = normalizeMetadata(data);
    const prefix = '[' + level + '] ' + timestamp() + ' - ' + message;

    if (meta !== undefined) {
        consoleMethod(prefix, meta);
    } else {
        consoleMethod(prefix);
    }
}

function info(message, data) {
    write('INFO ', console.log, message, data);
}

function warn(message, data) {
    write('WARN ', console.warn, message, data);
}

function error(message, data) {
    write('ERROR', console.error, message, data);
}

// Silent unless NODE_ENV !== 'production'. Use this for noisy,
// investigation-only logs (e.g. "cache miss for key X") that would just
// be clutter in a production log stream.
function debug(message, data) {
    if (config.isProduction) {
        return;
    }
    write('DEBUG', console.log, message, data);
}

module.exports = { info, warn, error, debug };