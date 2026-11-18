'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cfg = {
    url: (process.env.SECURITY_MONITOR_URL || 'http://127.0.0.1:5005').replace(/\/$/, ''),
    secret: process.env.SERVICE_HMAC_SECRET || process.env.SECURITY_MONITOR_SECRET || '',
    pepper: process.env.SECURITY_MONITOR_PEPPER || process.env.SERVICE_HMAC_SECRET || '',
    enforce: process.env.SECURITY_ENFORCE_BLOCKS === 'true',
    enabled: process.env.SECURITY_MONITOR_ENABLED !== 'false',
    spoolFile: process.env.SECURITY_MONITOR_SPOOL || path.join(os.tmpdir(), 'security-monitor-spool.jsonl'),
    spoolMaxBytes: 10 * 1024 * 1024,
    queueMax: 5000,
    batchSize: 50,
    flushMs: 1000,
    blocklistMs: 5000,
    timeoutMs: 3000,
};

const queue = [];
let dropped = 0;
let blockSet = new Map();
let backoffUntil = 0;
let backoffMs = 1000;
let flushing = false;
let started = false;
let lastWarningAt = 0;

function warnFailure(operation, error) {
    if (Date.now() - lastWarningAt < 60000) return;
    lastWarningAt = Date.now();
    const code = error && (error.code || error.status);
    console.warn(`[security-agent] ${operation} failed${code ? ` (${code})` : ''}; continuing fail-open`);
}

function signedHeaders(method, urlPath, bodyBuf) {
    const ts = String(Date.now());
    const nonce = crypto.randomBytes(16).toString('hex');
    const bodyHash = crypto.createHash('sha256').update(bodyBuf).digest('hex');
    const signature = crypto.createHmac('sha256', cfg.secret)
        .update(`${ts}\n${nonce}\n${method}\n${urlPath}\n${bodyHash}`)
        .digest('hex');
    return { 'x-sm-timestamp': ts, 'x-sm-nonce': nonce, 'x-sm-signature': signature };
}

async function call(method, urlPath, bodyObj) {
    const body = bodyObj ? Buffer.from(JSON.stringify(bodyObj)) : Buffer.alloc(0);
    const response = await fetch(cfg.url + urlPath, {
        method,
        body: body.length ? body : undefined,
        headers: { 'content-type': 'application/json', ...signedHeaders(method, urlPath, body) },
        signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (!response.ok) {
        const error = new Error(`monitor responded ${response.status}`);
        error.status = response.status;
        throw error;
    }
    return response.json();
}

function spoolAppend(events) {
    try {
        fs.appendFileSync(cfg.spoolFile, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
        const size = fs.statSync(cfg.spoolFile).size;
        if (size > cfg.spoolMaxBytes) {
            const lines = fs.readFileSync(cfg.spoolFile, 'utf8').split('\n').filter(Boolean);
            const keep = lines.slice(Math.floor(lines.length / 2));
            dropped += lines.length - keep.length;
            fs.writeFileSync(cfg.spoolFile, keep.join('\n') + '\n');
        }
    } catch (error) {
        dropped += events.length;
        warnFailure('spool write', error);
    }
}

function spoolTake(max) {
    try {
        if (!fs.existsSync(cfg.spoolFile)) return null;
        const lines = fs.readFileSync(cfg.spoolFile, 'utf8').split('\n').filter(Boolean);
        if (!lines.length) return null;
        return { events: lines.slice(0, max).map((line) => JSON.parse(line)), rest: lines.slice(max) };
    } catch (error) {
        warnFailure('spool read', error);
        return null;
    }
}

function spoolCommit(rest) {
    try {
        if (rest.length) fs.writeFileSync(cfg.spoolFile, rest.join('\n') + '\n');
        else fs.unlinkSync(cfg.spoolFile);
    } catch (error) {
        warnFailure('spool update', error);
    }
}

function push(event) {
    if (!cfg.enabled || !cfg.secret) return;
    if (queue.length >= cfg.queueMax) {
        queue.shift();
        dropped++;
    }
    queue.push(event);
    if (queue.length >= cfg.batchSize) setImmediate(flush);
}

async function flush() {
    if (flushing || Date.now() < backoffUntil || !cfg.enabled || !cfg.secret) return;
    flushing = true;
    try {
        const spooled = spoolTake(100);
        if (spooled) {
            await call('POST', '/internal/events', { events: spooled.events });
            spoolCommit(spooled.rest);
        }
        while (queue.length) {
            const batch = queue.splice(0, 100);
            try {
                await call('POST', '/internal/events', { events: batch, dropped: dropped || undefined });
                dropped = 0;
            } catch (error) {
                if (error.status && error.status >= 400 && error.status < 500 && error.status !== 429) {
                    dropped += batch.length;
                    throw error;
                }
                spoolAppend(batch);
                throw error;
            }
        }
        backoffMs = 1000;
    } catch (error) {
        backoffUntil = Date.now() + backoffMs;
        backoffMs = Math.min(backoffMs * 2, 60000);
        warnFailure('monitor delivery', error);
    } finally {
        flushing = false;
    }
}

async function refreshBlocklist() {
    if (!cfg.enforce || !cfg.secret || !cfg.enabled) return;
    try {
        const data = await call('GET', '/internal/blocklist');
        blockSet = new Map(data.items.map((item) => [item.ip, item.expiresAt]));
    } catch (error) {
        warnFailure('blocklist refresh', error);
    }
}

function start() {
    if (started || !cfg.enabled) return;
    started = true;
    if (!cfg.secret) {
        console.warn('[security-agent] SERVICE_HMAC_SECRET not set - agent disabled');
        return;
    }
    setInterval(flush, cfg.flushMs).unref();
    setInterval(refreshBlocklist, cfg.blocklistMs).unref();
    refreshBlocklist();
}

function isBlocked(ip) {
    const expiresAt = blockSet.get(ip);
    if (!expiresAt) return false;
    if (expiresAt <= Date.now()) {
        blockSet.delete(ip);
        return false;
    }
    return true;
}

function middleware() {
    start();
    return function securityMonitorAgent(req, res, next) {
        const startedAt = process.hrtime.bigint();
        const ip = req.ip || (req.socket && req.socket.remoteAddress) || '';
        let blocked = false;

        if (cfg.enforce && ip && isBlocked(ip)) {
            blocked = true;
            res.status(403).json({ error: 'Forbidden' });
        }

        let done = false;
        res.on('close', () => {
            if (done) return;
            done = true;
            const route = req.route && req.route.path
                ? `${req.baseUrl || ''}${typeof req.route.path === 'string' ? req.route.path : ''}`
                : undefined;
            const accept = String(req.headers.accept || '');
            push({
                type: 'access',
                eventId: crypto.randomUUID(),
                ts: new Date().toISOString(),
                ip,
                method: req.method,
                path: String(req.originalUrl || req.url || '/').split('?')[0].slice(0, 2000),
                route,
                routeMatched: !!req.route,
                status: res.statusCode,
                durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
                userAgent: String(req.headers['user-agent'] || '').slice(0, 500) || undefined,
                streaming: accept.includes('text/event-stream') || undefined,
                blocked: blocked || undefined,
            });
        });
        if (!blocked) next();
    };
}

function reportAuth(req, outcome, identifier) {
    const event = {
        type: 'auth',
        eventId: crypto.randomUUID(),
        ts: new Date().toISOString(),
        ip: req.ip || '',
        outcome,
        path: String(req.originalUrl || '').split('?')[0].slice(0, 2000),
    };
    if (identifier && cfg.pepper) {
        event.accountHash = crypto.createHmac('sha256', cfg.pepper)
            .update(String(identifier).trim().toLowerCase())
            .digest('hex');
    }
    push(event);
}

function reportUrlRejected(req, reason, host) {
    push({
        type: 'url_rejected',
        eventId: crypto.randomUUID(),
        ts: new Date().toISOString(),
        ip: req.ip || '',
        reason,
        host: host ? String(host).slice(0, 253) : undefined,
        path: String(req.originalUrl || '').split('?')[0].slice(0, 2000),
    });
}

module.exports = { middleware, reportAuth, reportUrlRejected, flush };
