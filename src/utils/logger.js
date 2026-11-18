'use strict';

const path = require('path');
const pino = require('pino');
const config = require('../config/env');
const { RotatingFileStream, LogFileRouter } = require('./rotatingFileStream');

const redactPaths = [
    'password', '*.password', 'authorization', '*.authorization',
    'cookie', '*.cookie', 'cookies', '*.cookies',
    'token', '*.token', 'accessToken', '*.accessToken',
    'refreshToken', '*.refreshToken', 'apiKey', '*.apiKey',
    'adminApiKey', '*.adminApiKey', 'email', '*.email',
    'phone', '*.phone', 'mobile', '*.mobile', 'address', '*.address',
    'name', '*.name', 'firstName', '*.firstName', 'lastName', '*.lastName',
    'dateOfBirth', '*.dateOfBirth', 'dob', '*.dob', 'secret', '*.secret',
    'otp', '*.otp', 'mfaCode', '*.mfaCode', 'captchaToken', '*.captchaToken',
    'challengeToken', '*.challengeToken', 'resetToken', '*.resetToken',
    'verificationCode', '*.verificationCode',
];

const loggerOptions = {
    level: config.isProduction ? 'info' : 'debug',
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: redactPaths, censor: '[REDACTED]' },
};

const usePrettyTransport = config.env === 'development';
const pinoLogger = pino(Object.assign({}, loggerOptions, usePrettyTransport ? {
    transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
    },
} : {}));

let fileLogger = null;
let fileRouter = null;
const fileStreams = [];
if (config.logging && config.logging.toFile) {
    const makeFileStream = function(fileName) {
        const stream = new RotatingFileStream(
            path.resolve(process.cwd(), config.logging.directory, fileName),
            config.logging.maxFileSizeBytes,
            config.logging.retentionFiles
        );
        fileStreams.push(stream);
        return stream;
    };

    fileRouter = new LogFileRouter({
        application: makeFileStream('application.log'),
        error: makeFileStream('error.log'),
        security: makeFileStream('security.log'),
        access: makeFileStream('access.log'),
    });
    fileLogger = pino(loggerOptions, fileRouter);
}

function isSensitiveKey(key) {
    const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
    return [
        'password', 'passwd', 'pwd', 'authorization', 'cookie', 'cookies',
        'token', 'accesstoken', 'refreshtoken', 'tokenhash', 'apikey',
        'adminapikey', 'xapikey', 'xadminkey', 'rapidapikey', 'key',
        'email', 'phone', 'mobile', 'address', 'name', 'username',
        'firstname', 'lastname', 'dateofbirth', 'dob', 'secret', 'query',
        'otp', 'mfacode', 'captchatoken', 'challengetoken', 'resettoken', 'verificationcode',
    ].indexOf(normalized) !== -1;
}

function sanitizeString(value) {
    return value
        .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
        .replace(/\bBasic\s+[A-Za-z0-9+/=]+/gi, 'Basic [REDACTED]')
        .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]')
        .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[REDACTED]@')
        .replace(/([?&][^=&\s]+)=([^&#\s]*)/g, '$1=[REDACTED]')
        .replace(/\b(password|passwd|pwd|access[_-]?token|refresh[_-]?token|captcha[_-]?token|challenge[_-]?token|reset[_-]?token|token|mfa[_-]?code|verification[_-]?code|otp|cookie|secret|(?:x-)?api[_-]?key|admin[_-]?key|email|phone|mobile|address|first[_-]?name|last[_-]?name)\s*[:=]\s*["']?[^"'\s,;]+/gi, '$1=[REDACTED]')
        .replace(/\b(?:cookie|set-cookie)\s*:\s*[^\r\n]*/gi, 'Cookie: [REDACTED]')
        .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
        .replace(/\b(x-api-key|x-admin-key|rapidapi-key|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
}

function sanitizeValue(value, seen) {
    if (typeof value === 'string') {
        return sanitizeString(value);
    }
    if (value === null || typeof value !== 'object') {
        return value;
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (value instanceof Error) {
        return {
            message: sanitizeString(value.message),
            stack: typeof value.stack === 'string' ? sanitizeString(value.stack) : value.stack,
        };
    }
    if (seen.has(value)) {
        return '[Circular]';
    }
    seen.add(value);

    if (Array.isArray(value)) {
        return value.map(function(item) {
            return sanitizeValue(item, seen);
        });
    }

    const sanitized = {};
    Object.keys(value).forEach(function(key) {
        sanitized[key] = isSensitiveKey(key) ? '[REDACTED]' : sanitizeValue(value[key], seen);
    });
    return sanitized;
}

function normalizeMetadata(data) {
    if (data === undefined || data === null) {
        return undefined;
    }
    return sanitizeValue(data, new WeakSet());
}

function buildMetadata(data, eventType) {
    const meta = normalizeMetadata(data);
    if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
        return Object.assign({}, meta, { eventType: eventType });
    }
    if (meta === undefined) {
        return { eventType: eventType };
    }
    return { eventType: eventType, data: meta };
}

function write(pinoMethod, message, data, eventType) {
    const metadata = buildMetadata(data, eventType || 'application');
    pinoMethod.call(pinoLogger, metadata, sanitizeString(String(message)));
    if (fileLogger) {
        fileLogger[pinoMethod === pinoLogger.error ? 'error' :
            pinoMethod === pinoLogger.warn ? 'warn' :
                pinoMethod === pinoLogger.debug ? 'debug' : 'info'](
            metadata,
            sanitizeString(String(message))
        );
    }
}

function info(message, data) {
    write(pinoLogger.info, message, data);
}

function warn(message, data) {
    write(pinoLogger.warn, message, data);
}

function error(message, data) {
    write(pinoLogger.error, message, data, 'error');
}

function debug(message, data) {
    write(pinoLogger.debug, message, data);
}

function security(message, data, level) {
    const method = level === 'error' ? pinoLogger.error : level === 'warn' ? pinoLogger.warn : pinoLogger.info;
    write(method, message, data, 'security');
}

function access(message, data) {
    write(pinoLogger.info, message, data, 'access');
}

function network(message, data, level) {
    const method = level === 'error' ? pinoLogger.error : level === 'warn' ? pinoLogger.warn : pinoLogger.info;
    write(method, message, data, 'network');
}

function flush() {
    if (!fileRouter) {
        return Promise.resolve();
    }

    return new Promise(function(resolve) {
        if (fileRouter.writableFinished) {
            resolve();
        } else {
            fileRouter.end(resolve);
        }
    }).then(function() {
        return Promise.all(fileStreams.map(function(stream) {
            if (stream.writableFinished) {
                return Promise.resolve();
            }
            return new Promise(function(resolve) {
                stream.end(resolve);
            });
        }));
    });
}

module.exports = { info, warn, error, debug, security, access, network, flush };
