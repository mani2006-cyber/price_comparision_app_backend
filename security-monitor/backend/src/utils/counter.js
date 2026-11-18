'use strict';
const { redis } = require('../config/redis');
const K = require('./redisKeys');

/** Atomic fixed-window counter (INCR + EXPIRE in one pipeline). Returns the new count. */
async function hit(name, id, windowSec, atMs = Date.now()) {
  const bucket = Math.floor(atMs / 1000 / windowSec);
  const key = K.counter(name, id, bucket);
  const res = await redis.pipeline().incr(key).expire(key, windowSec * 2).exec();
  if (res[0][0]) throw res[0][0];
  return Number(res[0][1]);
}

module.exports = { hit };
