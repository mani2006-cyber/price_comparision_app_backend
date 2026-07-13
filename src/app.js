// src/app.js
//
// The real Express application - wires every middleware and route file
// together, in the correct order. server.js imports this and calls
// .listen() on it; this file has no knowledge of ports or process
// lifecycle, keeping it importable/testable on its own (e.g. with
// supertest) without actually starting a server.

'use strict';

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const config = require('./config/env');
const { apiLimiter } = require('./middleware/rateLimiter.middleware');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

const authRoutes = require('./routes/auth.routes');
const productRoutes = require('./routes/product.routes');
const wishlistRoutes = require('./routes/wishlist.routes');
const alertRoutes = require('./routes/alert.routes');
const notificationRoutes = require('./routes/notification.routes');

const app = express();

// ── Core middleware ─────────────────────────────────────────────────
// credentials: true is REQUIRED for the refresh-token cookie (File 39)
// to be sent cross-origin at all - and per the cors package's own
// behavior, that requires an explicit origin list, never '*'.
app.use(cors({
    origin: config.corsOrigins,
    credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

// ── Rate limiting (global default - see rateLimiter.middleware.js for
// route-specific stricter limits already applied inside auth.routes.js
// and product.routes.js) ────────────────────────────────────────────
app.use(apiLimiter);

// ── Health check - deliberately trivial, no DB/service calls, so a
// deployment platform or uptime monitor has something to ping that
// never fails due to business logic ─────────────────────────────────
app.get('/health', function(req, res) {
    res.status(200).json({ success: true, status: 'ok', timestamp: new Date().toISOString() });
});

// ── Routes ───────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api', productRoutes); // defines /search, /search/history, /products/:id, /compare-url internally
app.use('/api/wishlist', wishlistRoutes);
app.use('/api/alerts', alertRoutes);
app.use('/api/notifications', notificationRoutes);

// ── 404 + error handling - MUST be last ─────────────────────────────
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;