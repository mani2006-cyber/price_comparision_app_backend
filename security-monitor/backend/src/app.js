'use strict';
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const config = require('./config/env');
const db = require('./config/mysql');
const { redis } = require('./config/redis');
const { apiLimiter } = require('./middleware/rateLimit');
const { notFound, errorHandler } = require('./middleware/errorHandler');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.isProd ? 1 : false);

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        connectSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        formAction: ["'self'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
  }));

  // Machine-to-machine route first: no CORS (the agent is not a browser), raw body, HMAC auth.
  app.use('/internal', require('./routes/internal.routes'));

  app.use(cors({
    origin: (origin, cb) => cb(null, !origin || config.frontendOrigins.includes(origin)),
    credentials: true, methods: ['GET', 'POST', 'PUT', 'DELETE'], allowedHeaders: ['Content-Type', 'X-Requested-With'], maxAge: 600,
  }));
  app.use(cookieParser());
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', async (req, res) => {
    const out = { status: 'ok', mysql: 'ok', redis: 'ok' };
    try { await db.ping(); } catch { out.mysql = 'down'; }
    try { await redis.ping(); } catch { out.redis = 'down'; }
    if (out.mysql !== 'ok' || out.redis !== 'ok') out.status = 'degraded';
    res.status(out.status === 'ok' ? 200 : 503).json(out);
  });

  app.use('/api/auth', apiLimiter, require('./routes/auth.routes'));
  app.use('/api/security', apiLimiter, require('./routes/security.routes'));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
