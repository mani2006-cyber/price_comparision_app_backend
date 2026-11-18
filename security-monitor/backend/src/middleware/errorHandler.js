'use strict';
const { AppError } = require('../utils/errors');
const logger = require('../utils/logger');

const notFound = (req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof AppError) return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: { code: 'TOO_LARGE', message: 'Payload too large' } });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Invalid JSON' } });
  logger.error({ err: err && err.message, stack: err && err.stack }, 'unhandled error');
  const down = err && (/ECONNREFUSED|ETIMEDOUT|PROTOCOL_CONNECTION_LOST|Connection is closed|max retries/i.test(String(err.message)) || err.code === 'ECONNREFUSED');
  if (down) return res.status(503).json({ error: { code: 'DEPENDENCY_DOWN', message: 'Service temporarily unavailable' } });
  return res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
}

module.exports = { notFound, errorHandler };
