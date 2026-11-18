'use strict';
const Redis = require('ioredis');
const config = require('./env');
const logger = require('../utils/logger');

const redis = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  db: config.redis.db,
  lazyConnect: true,
  maxRetriesPerRequest: 2,
  enableOfflineQueue: false,
  retryStrategy: (times) => Math.min(times * 200, 3000),
});

redis.on('error', (err) => logger.error({ err: err.message }, 'redis error'));

async function connect() {
  if (redis.status === 'wait') await redis.connect();
  await redis.ping();
}

module.exports = { redis, connect };
