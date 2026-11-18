'use strict';
require('dotenv').config();

const isProd = process.env.NODE_ENV === 'production';
const str = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const num = (k, d) => {
  const v = Number(str(k, d));
  if (!Number.isFinite(v)) throw new Error(`Env ${k} must be a number`);
  return v;
};

const config = {
  env: str('NODE_ENV', 'development'),
  isProd,
  port: num('PORT', 5005),
  frontendOrigins: str('FRONTEND_ORIGIN', 'http://localhost:5174').split(',').map((s) => s.trim()).filter(Boolean),
  mysql: {
    host: str('MYSQL_HOST', '127.0.0.1'),
    port: num('MYSQL_PORT', 3306),
    user: str('MYSQL_USER', 'root'),
    password: str('MYSQL_PASSWORD', ''),
    database: str('MYSQL_DATABASE', 'security_monitor'),
  },
  redis: {
    host: str('REDIS_HOST', '127.0.0.1'),
    port: num('REDIS_PORT', 6379),
    password: str('REDIS_PASSWORD', undefined),
    db: num('REDIS_DB', 5),
  },
  jwtSecret: str('JWT_SECRET', ''),
  jwtTtlMin: num('JWT_TTL_MIN', 15),
  hmacSecret: str('SERVICE_HMAC_SECRET', ''),
  hmacSecretPrevious: str('SERVICE_HMAC_SECRET_PREVIOUS', ''),
  cookieSecure: str('COOKIE_SECURE', isProd ? 'true' : 'false') === 'true',
  logLevel: str('LOG_LEVEL', 'info'),
};

/** Called by server.js (not by the migration script, which needs no secrets). */
config.assertSecrets = () => {
  for (const [name, v] of [['JWT_SECRET', config.jwtSecret], ['SERVICE_HMAC_SECRET', config.hmacSecret]]) {
    if (!v || v.length < 32) throw new Error(`${name} must be set to at least 32 characters (see .env.example)`);
  }
  if (config.jwtSecret === config.hmacSecret) throw new Error('JWT_SECRET and SERVICE_HMAC_SECRET must be different');
};

module.exports = config;
