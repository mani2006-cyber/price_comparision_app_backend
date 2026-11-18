'use strict';
/**
 * Authenticates the agent. Headers: x-sm-timestamp (ms), x-sm-nonce, x-sm-signature (hex).
 * signature = HMAC_SHA256(secret, `${timestamp}\n${nonce}\n${METHOD}\n${path}\n${sha256hex(body)}`)
 * Replay protection: +-60s time window and a one-time nonce stored in Redis.
 */
const crypto = require('crypto');
const config = require('../config/env');
const { redis } = require('../config/redis');
const K = require('../utils/redisKeys');
const { AppError } = require('../utils/errors');

const WINDOW_MS = 60000;
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sign = (secret, ts, nonce, method, path, bodyHash) =>
  crypto.createHmac('sha256', secret).update(`${ts}\n${nonce}\n${method}\n${path}\n${bodyHash}`).digest('hex');

function safeEqualHex(a, b) {
  const ba = Buffer.from(a, 'hex'); const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && ba.length > 0 && crypto.timingSafeEqual(ba, bb);
}

async function verifyServiceSignature(req, res, next) {
  try {
    const ts = req.get('x-sm-timestamp'); const nonce = req.get('x-sm-nonce'); const sig = req.get('x-sm-signature');
    if (!ts || !nonce || !sig || !/^\d{10,15}$/.test(ts) || !/^[A-Za-z0-9_-]{8,64}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(sig)) {
      throw new AppError(401, 'Bad signature headers', 'BAD_SIGNATURE');
    }
    if (Math.abs(Date.now() - Number(ts)) > WINDOW_MS) throw new AppError(401, 'Timestamp outside allowed window', 'BAD_SIGNATURE');

    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const bodyHash = sha256(body);
    const path = req.originalUrl.split('?')[0];
    const secrets = [config.hmacSecret, config.hmacSecretPrevious].filter(Boolean);
    const ok = secrets.some((s) => safeEqualHex(sign(s, ts, nonce, req.method, path, bodyHash), sig));
    if (!ok) throw new AppError(401, 'Invalid signature', 'BAD_SIGNATURE');

    // Only after the signature is valid: burn the nonce (so unauthenticated callers cannot fill Redis).
    const fresh = await redis.set(K.nonce(nonce), '1', 'EX', 120, 'NX');
    if (fresh !== 'OK') throw new AppError(401, 'Replay detected', 'REPLAY');

    if (body.length) {
      try { req.body = JSON.parse(body.toString('utf8')); } catch { throw new AppError(400, 'Invalid JSON', 'BAD_JSON'); }
    } else req.body = {};
    next();
  } catch (err) { next(err); }
}

module.exports = { verifyServiceSignature, sign, sha256 };
