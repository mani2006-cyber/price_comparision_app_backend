'use strict';
const http = require('http');
const config = require('./config/env');
const logger = require('./utils/logger');
const db = require('./config/mysql');
const redisCfg = require('./config/redis');
const { createApp } = require('./app');
const { createSocketServer } = require('./realtime/socket');
const broadcaster = require('./realtime/broadcaster');
const stats = require('./services/stats.service');
const blocking = require('./services/blocking.service');
const retention = require('./services/retention.service');

async function main() {
  config.assertSecrets();
  await db.ping();
  await redisCfg.connect();

  const server = http.createServer(createApp());
  createSocketServer(server);
  broadcaster.start(() => stats.getTick());

  const timers = [
    setInterval(() => blocking.sweepExpired().catch((e) => logger.error({ err: e.message }, 'sweep failed')), 30000),
    setInterval(() => retention.run().catch((e) => logger.error({ err: e.message }, 'retention failed')), 6 * 3600 * 1000),
  ];
  timers.forEach((t) => t.unref());
  setTimeout(() => retention.run().catch(() => {}), 60000).unref();

  server.listen(config.port, () => logger.info({ port: config.port, env: config.env }, 'Security monitor backend started'));

  let closing = false;
  const shutdown = async (sig) => {
    if (closing) return; closing = true;
    logger.info({ sig }, 'shutting down');
    broadcaster.stop();
    timers.forEach(clearInterval);
    server.close();
    await db.close().catch(() => {});
    redisCfg.redis.disconnect();
    setTimeout(() => process.exit(0), 300).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => { logger.fatal({ err: err.message }, 'startup failed'); process.exit(1); });
