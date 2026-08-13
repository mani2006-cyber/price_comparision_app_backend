# Price Compare Backend

A backend for a price-comparison platform: search products across multiple marketplaces, compare prices for the same product across them, track price history, wishlist items, set price-drop alerts, and get notified — over a live push connection, not just polling — the moment one fires.

## Contents

- [Tech stack](#tech-stack)
- [Architecture](#architecture)
- [Project structure](#project-structure)
- [Getting started](#getting-started)
- [Environment variables](#environment-variables)
- [API reference](#api-reference)
  - [Health](#health)
  - [Auth](#auth--apiauth)
  - [Search & products](#search--products--api)
  - [Wishlist](#wishlist--apiwishlist)
  - [Alerts](#alerts--apialerts)
  - [Notifications](#notifications--apinotifications)
- [Real-time notifications (SSE)](#real-time-notifications-sse)
- [Caching](#caching)
- [Background jobs](#background-jobs)
- [Supported marketplaces](#supported-marketplaces)
- [Testing](#testing)
- [Adding a new marketplace](#adding-a-new-marketplace)

## Tech stack

| Concern | Choice |
|---|---|
| HTTP framework | Express 4 |
| Database | MongoDB (Mongoose) |
| Cache | Redis (`ioredis`) — optional; the app runs correctly with it disabled, just without caching/queued jobs/cross-instance push |
| Background jobs | BullMQ (Redis-backed), falls back to `node-cron` if Redis is disabled |
| Real-time push | Server-Sent Events, fanned out via Redis Pub/Sub (falls back to an in-process `EventEmitter` if Redis is disabled) |
| Auth | JWT access tokens (`Authorization: Bearer`) + an HttpOnly refresh-token cookie |
| Validation | Zod schemas + a generic `validate()` middleware |
| Logging | `pino` (pretty-printed in dev, structured JSON in test/production) |
| Scraping | `axios` + `cheerio`, per-marketplace adapters under `src/adapters/` |
| Tests | Jest + Supertest |

## Architecture

Request flow is a straight line, every layer only knowing about the one below it:

```
routes  →  middleware (auth / validate / cache / rate-limit)  →  controllers  →  services  →  repositories  →  Mongoose models
```

- **routes** (`src/routes/`) wire an HTTP method+path to a controller, through whatever middleware that route needs.
- **controllers** (`src/controllers/`) are thin — parse the request, call a service, shape the JSON response. No business logic.
- **services** (`src/services/`) own business logic and cross-repository orchestration (e.g. `compare.service.js` calling out to multiple marketplace adapters and a repository).
- **repositories** (`src/repositories/`) are the only files that touch Mongoose directly.
- **adapters** (`src/adapters/`) are one-per-marketplace scrapers, all conforming to the same contract (see `src/adapters/provider.interface.js`) so the rest of the app never needs to know which marketplace it's talking to.

Two things sit outside that pipeline entirely:
- **`src/queues/priceRefresher.queue.js`** — a BullMQ worker that periodically re-checks stale product prices and fires alerts, independent of any HTTP request.
- **`src/realtime/notificationBus.js`** — the pub/sub fan-out behind the SSE notification stream (see [Real-time notifications](#real-time-notifications-sse)).

## Project structure

```
server.js                      Process entry point - DB connect, HTTP listen, graceful shutdown
src/
  app.js                       Express app definition (no listen()/process concerns - importable for tests)
  config/                      env.js (all config, validated at startup), db.js, redis.js
  routes/                      One file per resource - see API reference below
  controllers/                 HTTP layer - one file per resource, matches routes/
  services/                    Business logic
  repositories/                Mongoose access - one file per model
  models/                      Mongoose schemas
  middleware/                  auth, validate, cache, rate-limit, error handling
  validators/                  Zod schemas, one file per resource
  adapters/                    One folder per marketplace + the shared registry/contract
  realtime/                    notificationBus.js (SSE pub/sub)
  queues/                      priceRefresher.queue.js (BullMQ)
  jobs/                        priceRefresher.job.js (the actual "refresh stale prices" logic; also the node-cron fallback)
  utils/                       ApiError, asyncHandler, cache, logger, similarity scoring
tests/
  unit/                        No DB required - pure logic, mocked dependencies
  integration/                 Real MongoDB (a dedicated test database), routes exercised via Supertest
docs/
  ADDING-A-MARKETPLACE-ADAPTER.md   Step-by-step checklist for adding marketplace #9+
```

## Getting started

```bash
npm install
cp .env.example .env   # then fill in real secrets - see below
npm start               # or: npm run dev  (auto-restarts on file changes)
```

Requires a reachable MongoDB (`MONGO_URI`). Redis is optional — set `REDIS_ENABLED=false` to run without it; caching, the BullMQ price-refresher, and cross-instance notification push all degrade gracefully (search/product data still works; the price-refresher falls back to `node-cron`; notification push still works for same-process delivery).

Run the test suite (needs its own MongoDB database, name must contain `test` — see `.env.test`):

```bash
npm test
```

## Environment variables

See `.env.example` for the full list with defaults. The ones worth knowing about specifically:

| Variable | Purpose |
|---|---|
| `MONGO_URI` | Required. Must contain `test` for `.env.test` (`globalSetup.js` refuses to run otherwise, as a hard safety check against wiping a real database). |
| `ACCESS_TOKEN_SECRET` / `REFRESH_TOKEN_SECRET` | Must be two **different** secrets — validated at startup. |
| `REDIS_ENABLED` | `true`/`false`. Gates caching, BullMQ, and cross-instance SSE push — see [Architecture](#architecture). |
| `CACHE_SEARCH_TTL_SECONDS` / `CACHE_PRODUCT_TTL_SECONDS` / `CACHE_COMPARE_TTL_SECONDS` / `CACHE_NOTIFICATIONS_TTL_SECONDS` | Per-route cache TTLs. |
| `<MARKETPLACE>_PROVIDER_MODE` | `scraper` \| `api` \| `auto` — only meaningful for `amazon`/`flipkart`, the two marketplaces with a real official API as an alternative to scraping. |
| `PRICE_REFRESHER_CRON` | Cron pattern for the stale-price refresh job (BullMQ Job Scheduler when Redis is enabled, plain `node-cron` otherwise). |
| `CORS_ORIGINS` | Comma-separated allowlist. Any `http(s)://localhost:<port>` / `127.0.0.1:<port>` origin is **always** allowed regardless of this list (a frontend dev server landing on a different port every run shouldn't need a config edit) — see `app.js`. |

## API reference

Every response is JSON with a `success: boolean` field. Errors look like:

```json
{ "success": false, "error": "A search query 'q' is required", "details": [ { "field": "q", "message": "..." } ] }
```
(`details` is only present for validation failures; `stack` is only present outside production, and only for real 5xx errors.)

**Auth** — routes marked 🔒 require `Authorization: Bearer <accessToken>`. Get one from signup/login.

---

### Health

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | — | Trivial liveness check (no DB/service calls). `{ success, status: "ok", timestamp }` |

### Auth — `/api/auth`

Rate-limited (`AUTH_RATE_LIMIT_*`), stricter than the app-wide default. `signup`/`login` set an HttpOnly `refreshToken` cookie scoped to `/api/auth`.

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| POST | `/signup` | — | `{ name, email, password }` | `201` `{ success, user, accessToken }` |
| POST | `/login` | — | `{ email, password }` | `200` `{ success, user, accessToken }` |
| POST | `/refresh` | refresh cookie | — | `200` `{ success, accessToken }` — rotates the refresh token too |
| POST | `/logout` | refresh cookie | — | `200` `{ success, message }` — revokes the refresh token server-side and clears the cookie |

`user` never includes `password`. `email` must be a valid email format; `password` is not trimmed (a leading/trailing space is part of the password, not a mistake to silently correct).

### Search & products — `/api`

| Method | Path | Auth | Query / Body | Response |
|---|---|---|---|---|
| GET | `/search` | optional 🔒 | `?q=<required>&sortBy=price_asc\|price_desc\|rating&platform=<marketplace>` | `200` `{ success, query, resultCount, products, marketplaceFailures }` |
| GET | `/search/history` | 🔒 | `?limit=` | `200` `{ success, history }` |
| DELETE | `/search/history/:id` | 🔒 | — | `200` `{ success, message }` or `404` |
| GET | `/products/:id` | — | — | `200` `{ success, product }` or `404` |
| POST | `/compare-url` | — | `{ url }` | `200` `{ success, result }` — `result.detectedMarketplace`, `result.matchesFound`, `result.results[]` (the original product plus cross-marketplace matches, each carrying `isOriginal` and a `similarityScore`) |

- `GET /search` runs across **every active marketplace in parallel**; one marketplace failing doesn't drop the others' results — it's reported in `marketplaceFailures` instead (`[{ marketplace, message }]`).
- If `Authorization` is present, the search is recorded to that user's search history as a side effect (and the response is never cache-served, since a cache hit would silently skip that side effect).
- `platform` is accepted and recorded to search history, but does **not** currently filter results — every marketplace is always searched.
- `POST /compare-url` is rate-limited to 10 requests/minute (scraping-heavy). `url` must be a well-formed URL from a supported marketplace, or this returns `400` naming the marketplaces it does recognize.

### Wishlist — `/api/wishlist` 🔒 (every route)

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/` | `{ productId, notes? }` | `201` `{ success, item }` |
| GET | `/` | — | `200` `{ success, count, items }` — `items: [{ item: <wishlist entry, product populated live>, priceHistory: <last 30 days> }]` |
| GET | `/:id/history` | — | `200` `{ success, history }` — that item's full price history (not capped to 30 days) |
| DELETE | `/:id` | — | `200` `{ success, message }` |

A wishlist entry is a reference to a Product, never a data snapshot — price/title/stock are always populated live at read time. Adding the same product twice returns `409`. `GET /:id/history` and `DELETE /:id` 404 on an id that doesn't exist *or* belongs to a different user (ownership is never leaked via a different status code, e.g. `403`).

### Alerts — `/api/alerts` 🔒 (every route)

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/` | `{ productId, targetPrice }` | `201` `{ success, alert }` |
| GET | `/` | — | `200` `{ success, count, alerts }` |
| POST | `/:id/cancel` | — | `200` `{ success, alert }` |

`targetPrice` must be a positive number **strictly lower** than the product's current price (otherwise `400` — an alert that would fire immediately isn't "notify me when it drops"). Cancel is a soft state transition (`active` → `cancelled`), not a delete; cancelling an already-triggered/cancelled/nonexistent/not-yours alert all return `404`.

When an alert's target price is met (checked by the background price-refresher — see [Background jobs](#background-jobs)), it's marked `triggered` and a notification is created for its owner automatically.

### Notifications — `/api/notifications`

| Method | Path | Auth | Query / Body | Response |
|---|---|---|---|---|
| GET | `/stream` | 🔒 (header **or** `?token=`) | — | Server-Sent Events stream — see below |
| GET | `/` | 🔒 | `?limit=` | `200` `{ success, unreadCount, notifications }` (cached — see [Caching](#caching)) |
| POST | `/:id/read` | 🔒 | — | `200` `{ success, notification }` or `404` |
| POST | `/read-all` | 🔒 | — | `200` `{ success, modifiedCount }` |

## Real-time notifications (SSE)

`GET /api/notifications/stream` opens a long-lived [Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events) connection. The moment a notification is created for that user — from *any* code path, right now that's an Alert firing during the price-refresher job — it's written to every open stream for that user, with **no polling involved**. This works correctly even across multiple horizontally-scaled server instances (a notification created by one instance's background job reaches a user's connection held open on a *different* instance), via Redis Pub/Sub; if `REDIS_ENABLED=false`, push still works for same-process delivery.

`EventSource` (the browser API for consuming this) can't set custom headers, so the access token goes as a query parameter instead of the usual `Authorization` header:

```js
const token = /* your stored access token */;
const es = new EventSource(`/api/notifications/stream?token=${token}`);

es.addEventListener('notification', (event) => {
  const notification = JSON.parse(event.data);
  // { _id, userId, type, title, message, data, isRead, createdAt, ... }
});
```

The connection also sends a comment-only `: ping` line every 25 seconds (keeps intermediary proxies/load balancers from timing out an idle connection) and an initial `: connected` comment so the client's `open` handler fires immediately rather than waiting for the first real notification.

## Caching

Search, product-detail, compare-url, and the notifications inbox are all cached in Redis via a shared `cacheResponse()` middleware (`src/middleware/cache.middleware.js`) — every cached response carries an `X-Cache: HIT` or `MISS` header. Caching is entirely optional infrastructure: with `REDIS_ENABLED=false`, every cache read is a no-op miss and every write silently does nothing — the app behaves identically, just without the speedup.

The notifications inbox cache is additionally **actively invalidated** on every write (a new notification, marking one/all read) rather than relying on its TTL alone — see `notification.repository.js`.

## Background jobs

`src/jobs/priceRefresher.job.js` finds products not checked recently, re-fetches each via its stored marketplace URL, and — if the price changed — checks whether any Alert's target was just met (creating a notification + pushing it live if so).

How it's *scheduled* depends on `REDIS_ENABLED`:
- **Enabled** (`src/queues/priceRefresher.queue.js`): a real BullMQ Job Scheduler + Worker, on the cron pattern in `PRICE_REFRESHER_CRON`. Note: BullMQ *catches up* on a missed tick if the process was down when it was due (unlike plain `node-cron`, which just silently skips it) — expect a refresh run immediately on startup if the schedule was overdue.
- **Disabled**: falls back to plain `node-cron`, same cron pattern, no catch-up behavior.

## Supported marketplaces

`amazon`, `flipkart`, `myntra`, `lenskart`, `nykaa`, `poorvika`, `vijaysales` — see `src/adapters/index.js` for the live registry. `amazon` and `flipkart` can run against a real official API (`<MARKETPLACE>_PROVIDER_MODE=api`/`auto`) in addition to scraping; every other marketplace is scraper-only.

## Testing

```bash
npm test          # full suite, once
npm run test:watch
```

Unit tests (`tests/unit/`) need no database — external dependencies (axios, ioredis, bullmq, etc.) are mocked. Integration tests (`tests/integration/`) run against a real MongoDB (name must contain `test`, enforced by `tests/setup/globalSetup.js`) via Supertest against the real Express app, with only the marketplace adapters mocked (no real network calls in CI).

## Adding a new marketplace

See [`docs/ADDING-A-MARKETPLACE-ADAPTER.md`](docs/ADDING-A-MARKETPLACE-ADAPTER.md) — a step-by-step checklist, including the one step (`Product.model.js`'s own marketplace enum) that fails completely silently if skipped.
