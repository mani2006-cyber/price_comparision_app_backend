# Price Compare Backend

A backend for a price-comparison platform: search products across multiple marketplaces, compare prices for the same product across them, wishlist items, set price-drop alerts, and get notified — over a live push connection, not just polling — the moment one fires.

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
  - [Categories](#categories--apicategories)
  - [Admin catalog](#admin-catalog--apiadminproducts--every-route-x-admin-key-header)
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
| Cache | Redis (`ioredis`) — optional; the app runs correctly with it disabled, just without caching/cross-instance push |
| Background jobs | `node-cron` (no Redis dependency) — see [Background jobs](#background-jobs) |
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
- **`src/jobs/priceRefresher.job.js`** — a node-cron job that periodically re-checks alerted product prices and fires alerts, independent of any HTTP request. See [Background jobs](#background-jobs).
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
  queues/                      priceRefresher.queue.js - a BullMQ version of the price-refresher, present and tested but NOT currently wired into server.js (see Background jobs) - kept in case a manually-triggered "refresh now" path is wanted later
  jobs/                        priceRefresher.job.js - the real, currently-used price-refresher (node-cron)
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

Requires a reachable MongoDB (`MONGO_URI`). Redis is optional — set `REDIS_ENABLED=false` to run without it; caching and cross-instance notification push degrade gracefully (search/product data still works; notification push still works for same-process delivery). The price-refresher job (`node-cron`) has no Redis dependency at all.

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
| `REDIS_ENABLED` | `true`/`false`. Gates caching and cross-instance SSE push — see [Architecture](#architecture). Does NOT affect the price-refresher job (always `node-cron`, no Redis dependency). |
| `CACHE_SEARCH_TTL_SECONDS` / `CACHE_PRODUCT_TTL_SECONDS` / `CACHE_COMPARE_TTL_SECONDS` / `CACHE_CATEGORY_TTL_SECONDS` / `CACHE_NOTIFICATIONS_TTL_SECONDS` | Per-route cache TTLs. |
| `<MARKETPLACE>_PROVIDER_MODE` | `scraper` \| `api` \| `auto` — only meaningful for `amazon`/`flipkart`, the two marketplaces with a real official API as an alternative to scraping. |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` | App-wide default rate limit (`apiLimiter`, applied globally in `app.js`) — default 20 requests/minute per IP. Route-specific limiters (`AUTH_RATE_LIMIT_*`, `COMPARE_RATE_LIMIT_*`) are stricter and stack on top of this, not instead of it. |
| `COMPARE_RATE_LIMIT_WINDOW_MS` / `COMPARE_RATE_LIMIT_MAX` | `/compare-url`'s own limiter (default 10/min — the most scraping-heavy endpoint). Used to be hardcoded directly in `product.routes.js`; now tunable without a code change. |
| `PRICE_REFRESHER_CRON` | Cron pattern for the price-refresher job (`node-cron`), default every 6 hours. |
| `CORS_ORIGINS` | Comma-separated allowlist. Any `http(s)://localhost:<port>` / `127.0.0.1:<port>` origin (and, outside production, any private-LAN IP — phone-on-wifi testing) is **always** allowed regardless of this list — see `app.js`. |
| `SCRAPER_TIMEOUT_MS` / `SCRAPER_MAX_SEARCH_RESULTS` | Shared by every scraper-based adapter's own axios requests and result-count cap. Used to be 7 near-identical hardcoded constants (a mix of 15000/20000ms, all `= 8`) duplicated one per adapter file. |
| `AMAZON_SCRAPER_MAX_RETRIES` / `_BASE_DELAY_MS` / `_MAX_DELAY_MS` / `_CIRCUIT_FAILURE_THRESHOLD` / `_CIRCUIT_COOLDOWN_MS` | `amazon.scraper.js`'s own retry/backoff/circuit-breaker tuning — the only adapter with this level of resilience logic. |
| `API_MAX_SEARCH_RESULTS` / `RAPIDAPI_TIMEOUT_MS` | Official-API (`amazon.api.js`/`flipkart.api.js`) search cap and RapidAPI request timeout — kept separate from the scraper values above since a metered API call has a different cost profile than a scrape. |
| `COMPARE_MIN_PRICE_RATIO` / `COMPARE_MAX_PRICE_RATIO` / `COMPARE_MIN_TITLE_SIMILARITY` | Cross-marketplace matching thresholds (`src/utils/similarity.js`) — see that file's own comments for the regression stories (Fujifilm camera, accessory price mismatch) behind each specific value. |
| `PRODUCT_MAX_IMAGES` | Image-count cap, enforced identically in `Product.model.js`'s schema, `provider.interface.js`'s adapter-output validator, and every adapter's own truncation — all three read this same value so they can't silently drift out of sync. |
| `CATEGORY_DEFAULT_LIMIT` / `CATEGORY_MAX_LIMIT` | Default and maximum page size for `GET /categories/:category/products`. |
| `ADMIN_API_KEY` | Required for `/api/admin/products/*` to accept **any** request — checked against the `x-admin-key` header. Single shared secret, no per-user admin accounts. Unset = every admin route rejects (fails closed), not "admin routes disabled". |
| `SEARCH_DEFAULT_LIMIT` / `SEARCH_MAX_LIMIT` | Default and maximum page size for `GET /search` — paginates the already-fetched, already-cached merged result set (see that route's own notes above), not a separate fetch per page. |
| `SIMILAR_PRODUCTS_DEFAULT_LIMIT` / `SIMILAR_PRODUCTS_MAX_LIMIT` | Default and maximum page size for `result.similarProducts` on `POST /compare-url`. `MAX_SIMILAR_PRODUCTS` (separate var) caps the underlying pool these paginate over, not the page size itself. |
| `SSE_HEARTBEAT_MS` | How often the notification stream (`GET /notifications/stream`) writes a keepalive ping. |
| `OPENROUTER_API_KEY` | Optional. Powers `result.aiSummary` on `POST /compare-url` — see that route's own notes above. Unset = feature silently disabled, nothing else affected. |
| `OPENROUTER_MODEL` / `OPENROUTER_MAX_TOKENS` / `OPENROUTER_TEMPERATURE` | Which model to use for the summary (defaults to the free `nvidia/nemotron-3-ultra-550b-a55b:free`), and its generation parameters. |

## API reference

Every response is JSON with a `success: boolean` field. Errors look like:

```json
{ "success": false, "error": "A search query 'q' is required", "details": [ { "field": "q", "message": "..." } ] }
```
(`details` is only present for validation failures; `stack` is only present outside production, and only for real 5xx errors.)

**Auth** — routes marked 🔒 require `Authorization: Bearer <accessToken>`. Get one from signup/login. Routes marked 🔑 require an `x-admin-key` header instead — a separate, single shared secret (`ADMIN_API_KEY`), not a user token.

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
| GET | `/search` | optional 🔒 | `?q=<required>&sortBy=price_asc\|price_desc\|rating&platform=<marketplace>&page=&limit=` | `200` `{ success, query, resultCount, products, page, limit, totalPages, marketplaceFailures }` |
| GET | `/search/history` | 🔒 | `?limit=` | `200` `{ success, history }` |
| DELETE | `/search/history/:id` | 🔒 | — | `200` `{ success, message }` or `404` |
| GET | `/products/:id` | — | — | `200` `{ success, product }` or `404` |
| POST | `/compare-url` | — | `{ url }` in body, `?page=&limit=` in query | `200` `{ success, result }` — `result.detectedMarketplace`, `result.matchesFound`, `result.results[]` (the original product plus cross-marketplace matches, each carrying `isOriginal` and a `similarityScore`), `result.similarProducts[]` (+ `similarProductsPage`/`Limit`/`Total`/`TotalPages`), `result.aiSummary` |

- `GET /search` runs across **every active marketplace in parallel**; one marketplace failing doesn't drop the others' results — it's reported in `marketplaceFailures` instead (`[{ marketplace, message }]`).
- If `Authorization` is present, the search is **always** recorded to that user's search history — a repeat identical search still records a hit (bumping `searchCount` on the same history row) even when the underlying data came from cache; see [Caching](#caching) for why this is no longer a tradeoff the way it used to be.
- `platform` is accepted and recorded to search history, but does **not** currently filter results — every marketplace is always searched.
- `page`/`limit` paginate the response (default `page=1`, `limit=20`, capped at `limit=50`) — but **not** the underlying fetch: every active marketplace is always searched and the full merged result set is cached under the query text alone (see [Caching](#caching)), so requesting page 2 of an already-searched query is a cache hit, same shared fetch as page 1. `resultCount` is always the **total** across every page (also what gets recorded to search history), never just the current page's size.
- `POST /compare-url` is rate-limited (`COMPARE_RATE_LIMIT_*`, default 10 requests/minute — scraping-heavy). `url` must be a well-formed URL from a supported marketplace, or this returns `400` naming the marketplaces it does recognize. `page`/`limit` arrive as **query** params (`?page=2&limit=10`), not in the body — the body is reserved for `url`.
- `result.similarProducts[]` — related items ranked by **title similarity alone**, no price gate, no spec-match requirement, and unlike `results[]`, **any** marketplace including the same one as the original. This is what a same-marketplace variant (a different color/storage option) or a related accessory falls into — genuinely similar, just not a valid cross-retailer price comparison, so it's never mixed into `results[]`. Each entry carries a `similarityScore` (0–1) but no `isOriginal` flag. Never overlaps with `results[]` — anything already surfaced as a price-comparison match is excluded here.
  - **Paginated**: `similarProductsPage`/`similarProductsLimit`/`similarProductsTotal`/`similarProductsTotalPages` (default `page=1`, `limit=6`, capped at `limit=20` via `SIMILAR_PRODUCTS_MAX_LIMIT`). `similarProductsTotal` reflects the full underlying pool (up to `MAX_SIMILAR_PRODUCTS`, default 30) computed and cached **once** per URL — pagination itself is applied fresh on every request, cache hit or not, so two callers requesting different pages of the same URL never see each other's page (see [Caching](#caching) for why that split exists).
- `result.aiSummary` is a short, AI-generated, plain-English take on which listing is the better deal (via OpenRouter, `src/services/aiComparison.service.js`) — **optional**: it's `null` whenever `OPENROUTER_API_KEY` isn't set, there are no genuine cross-marketplace matches, or the call fails/times out/hits the free model's rate limit. It never blocks or fails the rest of the response — the algorithmic `results[]`/`similarityScore` ranking (which decides *which* products are matches in the first place) doesn't depend on it at all. It's generated from `results[]` only, not `similarProducts[]`, and — like the rest of the expensive work — only runs once per URL per cache TTL, regardless of how many different `similarProducts` pages get requested.

### Categories — `/api/categories`

Category browsing is backed by an **admin-curated catalog** (`AdminProduct`), not scraped marketplace data — the read side of the admin routes below. This replaced an earlier version that derived categories from whatever a prior `/search`/`/compare-url` call happened to persist, which meant coverage was entirely accidental (dense wherever users had searched, empty everywhere else, and skewed toward whichever marketplace's adapter happened to extract a category most reliably). An admin explicitly deciding what belongs in a category is the deliberate fix for that.

| Method | Path | Auth | Query | Response |
|---|---|---|---|---|
| GET | `/` | — | — | `200` `{ success, count, categories }` — `categories[]` is `{ category, count }`, alphabetical, `status: 'hidden'` entries excluded |
| GET | `/:category/products` | — | `?sortBy=price_asc\|price_desc\|rating&page=&limit=` | `200` `{ success, result }` — `result.products` are `AdminProduct` cards (`title`, `description`, `category`, `price`, `image`), plus `total`/`totalPages`/`page`/`limit` |
| GET | `/:category/products/:id` | — | `?sortBy=&page=&limit=` | `200` `{ success, result }` — `result.adminProduct` (the clicked card) + `result.listings` (live cross-marketplace search results for it, same shape as `GET /search`) |

- `category` matching is **case-insensitive** (MongoDB collation, not a regex) — `/categories/headphones/products` and `/categories/Headphones/products` are the same request. `limit` is capped at `CATEGORY_MAX_LIMIT` (50); default `page=1`, `limit=CATEGORY_DEFAULT_LIMIT` (20).
- The `:id` route is the "click a catalog card" flow: an `AdminProduct` entry has no real marketplace listing behind it (it's just curated `title`/`description`/`category`/`price` metadata), so clicking one triggers a genuine live multi-marketplace search keyed by its `title` — reusing `search.service.js`'s `runSearch` wholesale (same caching/pagination/persistence `GET /search` already has), just with the user's search-history recording skipped (a catalog click isn't something the user typed). A `status: 'hidden'` product 404s here too, not just from the listing above — hiding it removes it from both surfaces at once.
- All three routes are HTTP-response cached (`CACHE_CATEGORY_TTL_SECONDS`), and every write through the admin routes below actively invalidates the `GET /` list cache — no waiting out the TTL to see a newly-added category appear.

### Admin catalog — `/api/admin/products` 🔑 (every route, `x-admin-key` header)

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/` | `{ title, description?, category, price, image?, status? }` | `201` `{ success, product }` |
| GET | `/` | — (query: `?category=&page=&limit=`) | `200` `{ success, result }` — includes `hidden` entries too (admin view) |
| GET | `/:id` | — | `200` `{ success, product }` |
| PATCH | `/:id` | any subset of the create fields | `200` `{ success, product }` |
| DELETE | `/:id` | — | `200` `{ success, message }` |

This is the write side behind `GET /api/categories` above. Auth is a single shared secret (`ADMIN_API_KEY`, sent as `x-admin-key`) checked by `adminAuth.middleware.js` — **not** the user JWT system; there's no per-user admin role yet. The middleware fails **closed**: if `ADMIN_API_KEY` is unset, every admin route rejects with `500`, never silently allows requests through the way an unconfigured optional feature (e.g. OpenRouter) would. `status: 'hidden'` unpublishes an entry from public category browsing without deleting it; the admin CRUD routes can still see and edit it. `PATCH` with an empty body returns `400` (nothing to update).

### Wishlist — `/api/wishlist` 🔒 (every route)

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/` | `{ productId, notes? }` | `201` `{ success, item }` |
| GET | `/` | — | `200` `{ success, count, items }` — `items: [<wishlist entry, product populated live>]` |
| DELETE | `/:id` | — | `200` `{ success, message }` |

A wishlist entry is a reference to a Product, never a data snapshot — price/title/stock are always populated live at read time via `.populate()`, not cached at add-time. There is no separate price-history log or endpoint; `Product.lowestPrice`/`highestPrice` (visible on the populated product) are the only price-extreme data this app keeps. Adding the same product twice returns `409`. `DELETE /:id` 404s on an id that doesn't exist *or* belongs to a different user (ownership is never leaked via a different status code, e.g. `403`).

### Alerts — `/api/alerts` 🔒 (every route)

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/` | `{ productId, targetPrice }` | `201` `{ success, alert }` |
| GET | `/` | — | `200` `{ success, count, alerts }` |
| POST | `/:id/cancel` | — | `200` `{ success, alert }` |
| DELETE | `/:id` | — | `200` `{ success, message }` |

`targetPrice` must be a positive number **strictly lower** than the product's current price (otherwise `400` — an alert that would fire immediately isn't "notify me when it drops"). Cancel is a soft state transition (`active` → `cancelled`), scoped to *active* alerts only — cancelling an already-triggered/cancelled/nonexistent/not-yours alert all return `404`. `DELETE` is a genuine hard delete, removing the alert from the user's list regardless of its status (active, triggered, or cancelled); like every other ownership-scoped route in this app, deleting a nonexistent or not-yours alert also returns `404`, never `403`.

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

Two different layers, depending on the route:

- **HTTP-level** (`src/middleware/cache.middleware.js`, a `cacheResponse()` wrapper) — used by `GET /products/:id`, `GET /notifications`, and all three category routes (including the `:id` "click through" listings route — it never records search history the way `GET /search` does, so a cache HIT short-circuiting before the controller is safe there too). Every response through this layer carries an `X-Cache: HIT` or `MISS` header. On a HIT, the request never reaches the controller at all.
- **Service-level** (`src/utils/cache.js`'s `getOrSet()`, a plain cache-aside) — used by `GET /search` and `POST /compare-url`. `product.service.js`'s `searchAndPersist()` and `compare.service.js`'s `computeComparison()` each cache only the expensive part (the live marketplace fetch(es), matching, and — for compare-url — the AI summary call), by query text / URL alone; the controller **always** runs regardless of hit/miss, and any per-request shaping (search-history recording, `similarProducts` pagination) happens fresh every time on top of the cached-or-fresh result — no `X-Cache` header here, and no route ever short-circuits before reaching it.

That split exists on purpose, and both routes ended up there for related but distinct reasons. Search used to be HTTP-level-cached too (guest-only), because a cache HIT skipping the controller would also skip search-history recording for a logged-in user - so authenticated search had to opt out of caching entirely just to keep history working. Compare-url used to be HTTP-level-cached unconditionally too, until `result.similarProducts` became paginated: an HTTP-level whole-response cache keyed on the URL alone would have frozen whichever page got requested *first* and served that exact page to every caller for the rest of the TTL, no matter what page they actually asked for. Moving both down a layer fixes both problems the same way: the shared, expensive fetch is cached for everyone, while whatever runs on top of it (history recording, pagination) can no longer be silently skipped or staled by a cache hit. See `product.service.js`'s header comment on `searchAndPersist`, `compare.service.js`'s header comment, and `tests/integration/routes/product.routes.test.js`'s `"a repeat authenticated search hits the marketplace fetch only ONCE, but records history BOTH times"` / `"a cached URL still returns the correct page on a second call with DIFFERENT pagination"` tests for the proof.

Caching is entirely optional infrastructure either way: with `REDIS_ENABLED=false`, every cache read is a no-op miss and every write silently does nothing — the app behaves identically, just without the speedup.

Both layers also de-duplicate **concurrent** requests for the same key ("in-flight coalescing" / singleflight) — confirmed live: two near-simultaneous identical requests (e.g. a double-fired `compare-url` call) used to both miss the cache, since neither had finished writing yet, and both ran the full expensive pipeline independently — doubling live marketplace request volume and, for `compare-url`, doubling the OpenRouter AI call. Now a second request for a key that's already being computed just awaits that same in-progress computation instead of starting its own. This is an in-process `Map`, not Redis-backed, so it works even with caching itself disabled, and coalesces within a single server process only (the relevant scope for this app's current single-instance deployment).

The notifications inbox cache is additionally **actively invalidated** on every write (a new notification, marking one/all read) rather than relying on its TTL alone — see `notification.repository.js`.

## Background jobs

`src/jobs/priceRefresher.job.js` re-checks prices on a schedule (`PRICE_REFRESHER_CRON`, default every 6 hours), via plain `node-cron` - unconditional, no Redis dependency. `node-cron` only fires at the next real matching time; it never runs immediately on registration and never "catches up" on a missed tick after downtime, so nothing happens right at server startup.

Scoped to products that at least one user has an **active Alert** on, not the whole catalog - `productRepository.findStaleWithActiveAlerts()` finds active-alert product ids first, then filters to the stale ones among just those (not checked in the last 6 hours). For each: re-fetches via its stored marketplace URL, re-upserts (updating `lowestPrice`/`highestPrice`), and if the price changed, checks whether any Alert's target was just met - creating a notification and pushing it live if so. Processed sequentially with a delay between items (`PRICE_REFRESHER_DELAY_MS`), never concurrently - this job has no urgency, and hammering marketplaces with concurrent requests risks this app's own IP getting rate-limited or blocked.

`src/queues/priceRefresher.queue.js` (a BullMQ version of the same job) still exists and is tested but is **not** currently used by `server.js` - it was tried first, then reverted: BullMQ's Job Scheduler catches up on a missed tick the moment a Worker connects, which combined with the old "check the whole catalog" scope meant a full batch of live marketplace requests fired on every server restart. Kept around in case a manually-triggered "refresh now" path is wanted later.

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
