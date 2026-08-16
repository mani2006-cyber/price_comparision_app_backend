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
const categoryRoutes = require('./routes/category.routes');
const wishlistRoutes = require('./routes/wishlist.routes');
const alertRoutes = require('./routes/alert.routes');
const notificationRoutes = require('./routes/notification.routes');

const app = express();

// ── Core middleware ─────────────────────────────────────────────────
// credentials: true is REQUIRED for the refresh-token cookie (File 39)
// to be sent cross-origin at all - and per the cors package's own
// behavior, that requires an explicit origin, never '*'.
//
// LOCALHOST_ORIGIN_RE reflects any http(s)://localhost:<port> or
// 127.0.0.1:<port> origin - covers a frontend dev server landing on a
// different port every run (Vite bumping 5173 -> 5175 etc.) without
// having to hand-edit CORS_ORIGINS every time. Deliberately NOT a bare
// '*'/reflect-anything origin: with credentials: true, that would let
// ANY website make authenticated requests against this API using a
// logged-in user's cookies - scoping the wildcard to localhost keeps
// the convenience without that exposure. Anything else still has to be
// in config.corsOrigins explicitly (e.g. a real deployed frontend
// origin in production).
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

// The same convenience, extended to private LAN addresses, but DEVELOPMENT
// ONLY. Testing the frontend on a real phone means loading it from this
// machine's LAN IP rather than localhost - and that IP is DHCP-assigned, so
// it changes whenever the lease renews or the machine rejoins the network
// (this one has already moved 192.168.1.14 -> .6 -> .8). Pinning it in
// CORS_ORIGINS means every one of those changes silently breaks the API
// with a CORS error. Matching the private ranges instead keeps phone
// testing working across IP changes, and is gated on !isProduction so a
// deployed API never reflects an arbitrary private-range Origin.
const PRIVATE_LAN_ORIGIN_RE =
    /^https?:\/\/(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})(:\d+)?$/;

// NOTE: a bare `app.use(cors())` does NOT work for this app, even though it
// looks more permissive. With no options the cors package replies
// `Access-Control-Allow-Origin: *` and omits `Access-Control-Allow-Credentials`
// - and per the CORS spec a browser REJECTS a wildcard origin outright for any
// request made with `credentials: 'include'` ("...must not be the wildcard '*'
// when the request's credentials mode is 'include'"). Every auth call from the
// frontend uses credentials: 'include' to carry the refresh-token cookie, so a
// bare cors() breaks signup/login/refresh with "Failed to fetch" on desktop and
// phone alike. Reflecting the specific origin + credentials: true, as below, is
// the only configuration that works here.

app.use(cors({
    origin: function(origin, callback) {
        // No Origin header at all (curl, server-to-server, same-origin) -
        // nothing to check against, always allow.
        if (!origin) return callback(null, true);
        if (LOCALHOST_ORIGIN_RE.test(origin) || config.corsOrigins.indexOf(origin) !== -1) {
            return callback(null, true);
        }
        if (!config.isProduction && PRIVATE_LAN_ORIGIN_RE.test(origin)) {
            return callback(null, true);
        }
        return callback(new Error('Not allowed by CORS: ' + origin));
    },
    credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

// ── Rate limiting (global default - see rateLimiter.middleware.js for
// route-specific stricter limits already applied inside auth.routes.js
// and product.routes.js, which stack on top of this one). This used to
// be commented out - meaning NOTHING stopped a client from hammering
// /search or /compare-url repeatedly, burning RapidAPI/OpenRouter quota
// and risking exactly the "getting blocked by every marketplace" problem
// the price-refresher job was already fixed for once before. Safe to
// enable: .env.test's RATE_LIMIT_MAX is already set generously high
// (1000/window) specifically so the test suite's own request volume
// never trips this. ───────────────────────────────────────────────────
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
app.use('/api/categories', categoryRoutes);
app.use('/api/wishlist', wishlistRoutes);
app.use('/api/alerts', alertRoutes);
app.use('/api/notifications', notificationRoutes);

// ── 404 + error handling - MUST be last ─────────────────────────────
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;