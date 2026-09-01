# Restart Plan — Price Comparison Platform (JavaScript)

A clean-slate build plan for a BuyHatke-style price comparison backend.
**Plain JavaScript. No TypeScript.**

This is written to be worked through slowly, one phase at a time. Every phase
ends with something that runs, something you can demo, and a clear "if I stop
here, what do I have". Nothing is left half-wired between phases.

---

## Contents

1. [How to use this document](#1-how-to-use-this-document)
2. [Ground rules](#2-ground-rules)
3. [What to carry over from the last build](#3-what-to-carry-over-from-the-last-build)
4. [What to do differently this time](#4-what-to-do-differently-this-time)
5. [Tech stack](#5-tech-stack)
6. [Project structure](#6-project-structure)
7. [Layering rules](#7-layering-rules)
8. [Data model](#8-data-model)
9. [The phases](#9-the-phases)
10. [Milestone map](#10-milestone-map)
11. [Definition of done](#11-definition-of-done)

---

## 1. How to use this document

- **Do the phases in order.** Each one consumes what the previous one built.
  Phase 3 has nothing to match if Phase 2 never fetched anything.
- **Don't start a phase until the previous one's "Prove it works" passes.**
  That check is the whole point — it's what stops you from building three
  phases on top of a broken foundation.
- **A phase is not a week.** It's a unit of work. Take as long as it takes.
  The order matters; the pace doesn't.
- **Copy the good parts, retype them.** Section 3 lists what's worth taking
  from the previous build. Retyping beats copy-pasting — you'll understand
  what you kept.

---

## 2. Ground rules

These are decided up front so you never have to re-litigate them mid-build.

### JavaScript, ESM, Node 22

```json
// package.json
{
  "type": "module",
  "engines": { "node": ">=22" }
}
```

**Use ESM (`import`/`export`), not CommonJS (`require`).** Concrete reason,
not a style preference: the previous build hit a real wall when
`@openrouter/sdk` shipped as ESM-only. From CommonJS the only way in was a
dynamic `import()`, which Jest's mock registry can't intercept — so the tests
silently hit the real package, and an entire extra file had to exist just to
isolate that import. In an ESM project that problem doesn't exist. More and
more packages are ESM-only; starting there costs nothing and saves that fight.

### zod is your type system

Without TypeScript you have no compile-time checking. Don't pretend otherwise
and don't rely on discipline. Instead, **validate at every boundary at
runtime** — which catches things TypeScript never could, like a marketplace
silently changing its response shape in production.

```js
// packages/contracts/src/offer.schema.js
import { z } from 'zod';

export const RawOfferSchema = z.object({
  retailer:    z.enum(['amazon', 'flipkart', 'myntra', 'nykaa', 'lenskart']),
  externalId:  z.string().min(1),      // ASIN, Flipkart pid — STABLE, never random
  url:         z.string().url(),
  title:       z.string().min(1),
  brand:       z.string().nullable().default(null),
  pricePaise:  z.number().int().positive(),   // integer paise. never a float.
  mrpPaise:    z.number().int().positive().nullable().default(null),
  images:      z.array(z.string().url()).max(10).default([]),
  inStock:     z.boolean(),
  fetchedVia:  z.enum(['scraper', 'api']),
});

// Parse, don't trust. This throws with a precise path on bad input.
export const parseRawOffer = (input) => RawOfferSchema.parse(input);
```

Four boundaries where nothing gets through unvalidated:

| Boundary | Validate with |
|---|---|
| HTTP request in | `validate` middleware → zod schema |
| Scraper output | `parseRawOffer()` before it's allowed into a queue |
| Queue job in | schema parse at the top of every processor |
| Env vars at boot | one zod schema, parsed once, process exits on failure |

### JSDoc for editor help

You lose autocomplete without TypeScript. Get most of it back for free:

```js
/**
 * @param {string} query
 * @param {{ page?: number, limit?: number }} [options]
 * @returns {Promise<{ items: Array<object>, total: number }>}
 */
export async function search(query, options = {}) { ... }
```

Add a `jsconfig.json` with `"checkJs": true` if you want the editor to
actually flag mismatches — no build step, no compile, just better red squiggles.

### Comment the *why*, never the *what*

The single best thing about the previous build. `// increment counter` is
noise. This is worth its weight in gold six months later:

```js
// node-cron, NOT BullMQ's job scheduler. BullMQ "catches up" on a missed
// occurrence the moment a Worker connects — which meant a full batch of live
// marketplace re-fetches fired on EVERY server restart if the last scheduled
// tick passed while the process was down. That is a direct path to getting
// this app's IP blocked. node-cron has no catch-up: the first run only ever
// happens at the next real scheduled time.
```

---

## 3. What to carry over from the last build

These were earned. Take them.

| Idea | What it looked like | Why it's worth keeping |
|---|---|---|
| **One contract for every retailer** | `provider.interface.js` — every adapter returns the same `ProviderProduct` shape or throws | Swapping a scraper for an official API becomes a one-file change. Now becomes a zod schema. |
| **Registry dispatch** | `MARKETPLACE_REGISTRY = { amazon, flipkart, ... }` | Adding a retailer is one line, not an `if/else` chain that grows forever. |
| **`Promise.allSettled`, never `Promise.all`** | Cross-marketplace fan-out | One retailer being blocked must never zero out a search. Report the failure, return the rest. |
| **Redis is optional infrastructure** | `cache.get()` returns `null` if Redis is down; never throws, never delays | Callers need zero Redis-specific error handling. A cache outage costs latency, not correctness. |
| **Repository layer** | Services → repositories → models | Business logic stays testable and the store stays swappable. |
| **Hashed, rotating refresh tokens** | Signed JWT *plus* a DB row storing only the hash | A stateless-only JWT can't be revoked. This can. |
| **Per-domain throttle** | ≤2 concurrent, ≥1500 ms between request starts | The main thing standing between you and an IP ban. |
| **Expected failures are returned, not thrown** | `Result<T, Error>` with a `retryable` flag | A job runner processing 500 jobs branches on outcomes; it doesn't want 500 try/catch blocks. |
| **`server.js` separate from `app.js`** | `app.js` never calls `.listen()` | Lets tests import the app with supertest without booting a port. |
| **Trivial health check** | `/health` touches no database | If it can fail for a business reason, it lies — and health-gated deploys stop working. |
| **Cache the expensive half only** | `computeComparison()` cached by URL; `compareByUrl()` paginates fresh | Caching a paginated response by URL alone freezes page 1 and serves it to everyone. Real bug, real fix. |

---

## 4. What to do differently this time

Five changes. The first one is the big one.

### 4.1 Split `Product` into `product` + `offer`

The previous build stored **one document per marketplace listing** and called
it a Product. That merges two different things:

- *"Samsung Galaxy S24 Ultra 256GB Titanium Black"* — the actual thing
- *"Flipkart's listing of it"* — one place to buy it

Almost everything you want next needs them separate:

| You want | With one-doc-per-listing | With product + offers |
|---|---|---|
| "Cheapest price for this?" | Re-run matching at query time, every time | Read `product.bestPricePaise` — one indexed field |
| History after Flipkart delists it | History dies with the listing | Product history continues; the offer goes inactive |
| Alerts | "Tell me when *Flipkart* drops" | "Tell me when *anyone* drops" ← what users mean |
| Two listings on one retailer | Two unrelated products in the UI | Two offers, one product |

```
product  (canonical: the thing itself)
   ├── offer  (amazon)    ₹1,29,999   in stock
   ├── offer  (flipkart)  ₹1,24,900   in stock   ← bestOfferId
   └── offer  (vijay)     ₹1,31,500   out of stock
```

**Build this in Phase 3. Don't defer it** — retrofitting it later means
migrating every document you've collected.

### 4.2 The API never scrapes during a request

Previously a search could trigger live marketplace fetches inline. That makes
p95 latency unpredictable and ties your uptime to five third parties.

New rule: **a request reads from the database.** If the data is stale or
missing, it enqueues a job and either returns what it has or waits a bounded
2 seconds — never longer.

### 4.3 Scraping lives in its own process

Fetching is slow, gets blocked, is CPU-heavy for parsing, and talks to hostile
networks. Keep all of that out of the process serving your users. It also
means you can restart, scale, or rate-limit scraping without touching the API.

### 4.4 Integer paise everywhere

`₹1,24,900.00` is `12490000`. Never a float, in the database or on the wire.
Floating-point money produces rounding bugs that show up as ₹0.01 discrepancies
you'll spend a day chasing.

```js
// packages/core/src/money.js
export const rupeesToPaise = (r) => Math.round(r * 100);
export const paiseToRupees = (p) => p / 100;
export const formatINR = (p) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })
    .format(p / 100);
```

### 4.5 The scheduler only enqueues

It never does work itself. This is the direct fix for the incident documented
in the old `server.js`: a restart triggering a full-catalog live re-fetch.

Three independent brakes, so no single mistake reproduces it:

1. Scheduler **only enqueues** — a missed tick can't become a burst
2. Queue is **rate-limited per retailer** via a shared Redis token bucket —
   more workers can't mean more outbound traffic
3. Candidate set is **bounded by staleness AND demand**, hard-capped per tick

---

## 5. Tech stack

| Layer | Choice | Why this one |
|---|---|---|
| Runtime | Node.js 22 LTS | Native ESM, native fetch, native test runner if you want it |
| Language | **JavaScript (ESM)** | Your call — no build step, no transpile, faster feedback loop |
| API framework | Express 5 | You already know it. Express 5 handles async errors natively — no more `asyncHandler` wrapper needed |
| Database | MongoDB + Mongoose 8 | Product attributes are genuinely heterogeneous per category |
| Cache / queue / pubsub | Redis + ioredis | One dependency, four jobs |
| Job queue | BullMQ | Retries, backoff, rate limits, DLQ — all built in |
| Validation | **zod** | This is your type system. Non-negotiable. |
| Scraping | undici (fetch) + cheerio | Add Playwright only if a site genuinely needs JS rendering |
| Logging | pino | Structured JSON, fast |
| Testing | **Vitest** + mongodb-memory-server + supertest | Vitest runs ESM natively with no transform config. Jest needs setup for ESM — skip that fight. |
| Lint / format | ESLint 9 flat config + Prettier | |
| Hosting | Render + MongoDB Atlas | Both have workable free tiers for learning |

**On Vitest over Jest:** in an ESM project Jest needs experimental VM modules
and transform config to work properly. Vitest runs ESM natively, has a
Jest-compatible API (`describe`/`it`/`expect`/`vi.mock`), and is faster. There's
no upside to Jest here.

---

## 6. Project structure

```
price-compare/
│
├── package.json                    npm workspaces root · "type": "module"
├── .nvmrc                          22
├── .env.example                    every var, documented, committed
├── .gitignore                      .env  node_modules  coverage
├── docker-compose.yml              mongo + redis for local dev
├── eslint.config.js                flat config + the boundary rules (§7)
├── vitest.config.js
├── jsconfig.json                   checkJs: true — editor hints, no build
│
├── apps/                           ← things that run as their own process
│   │
│   ├── api/                        the public HTTP API           [Phase 1]
│   │   ├── package.json
│   │   ├── server.js               process lifecycle ONLY:
│   │   │                             boot order · signals · graceful drain
│   │   │                             owns process.exit. app.js never does.
│   │   └── src/
│   │       ├── app.js              express wiring only. no .listen().
│   │       │
│   │       ├── modules/            ← ONE FOLDER PER FEATURE
│   │       │   │
│   │       │   ├── auth/                                        [Phase 1]
│   │       │   │   ├── auth.routes.js       path → middleware → controller
│   │       │   │   ├── auth.controller.js   req/res only. no logic.
│   │       │   │   ├── auth.service.js      the logic. no req/res.
│   │       │   │   ├── auth.schema.js       zod: signup/login bodies
│   │       │   │   └── token.service.js     issue · rotate · revoke
│   │       │   │
│   │       │   ├── products/        canonical products           [Phase 4]
│   │       │   ├── offers/          listings + price history     [Phase 5]
│   │       │   ├── search/          query → products             [Phase 4]
│   │       │   ├── compare/         paste a URL → comparison     [Phase 4]
│   │       │   ├── categories/      browse the catalog           [Phase 4]
│   │       │   ├── wishlist/                                     [Phase 6]
│   │       │   ├── alerts/          price-drop alerts            [Phase 6]
│   │       │   ├── notifications/   inbox + SSE stream           [Phase 7]
│   │       │   └── admin/           curated catalog · retailers  [Phase 8]
│   │       │
│   │       ├── middleware/
│   │       │   ├── request-id.js        FIRST. attaches reqId to every log.
│   │       │   ├── auth.js              requireAuth · optionalAuth · requireRole
│   │       │   ├── validate.js          zod → 400 with the exact bad field
│   │       │   ├── rate-limit.js        global + per-route, Redis-backed
│   │       │   ├── cache.js             declarative response cache for GETs
│   │       │   ├── not-found.js
│   │       │   └── error-handler.js     LAST. the ONLY place errors → HTTP.
│   │       │
│   │       ├── clients/                 outbound HTTP, one file per dependency
│   │       │   ├── scraper.client.js
│   │       │   └── openrouter.client.js
│   │       │
│   │       └── realtime/
│   │           └── notification-bus.js  redis pub/sub ⇄ local EventEmitter
│   │
│   ├── scraper/                    fetch + parse. no database.   [Phase 2]
│   │   ├── package.json
│   │   ├── server.js               small express control plane
│   │   └── src/
│   │       ├── app.js              POST /jobs · /health · /metrics
│   │       │
│   │       ├── core/               ← what a connector may NOT bypass
│   │       │   ├── http.js         THE only way out to the network:
│   │       │   │                     throttle → robots → UA → retry →
│   │       │   │                     circuit-breaker → timeout → fetch
│   │       │   ├── throttle.js     per-domain concurrency + min spacing
│   │       │   ├── robots.js       fetch, cache 24h, obey robots.txt
│   │       │   ├── circuit.js      per-domain open / half-open / closed
│   │       │   ├── json-ld.js      schema.org/Product — ALWAYS TRY FIRST
│   │       │   └── registry.js     slug → connector. the only dispatch.
│   │       │
│   │       ├── connectors/         ← same 4 files for every retailer
│   │       │   ├── amazon/
│   │       │   │   ├── index.js        implements the connector contract
│   │       │   │   ├── selectors.js    EVERY css selector, isolated here
│   │       │   │   ├── parse.js        pure html → RawOffer. zero I/O.
│   │       │   │   └── search.js       search-results page handling
│   │       │   ├── flipkart/
│   │       │   ├── myntra/
│   │       │   ├── nykaa/
│   │       │   └── lenskart/
│   │       │
│   │       ├── sinks/              ← where a result goes. swappable.
│   │       │   ├── queue.sink.js       production → BullMQ
│   │       │   ├── file.sink.js        local dev
│   │       │   └── console.sink.js     CLI default, zero infrastructure
│   │       │
│   │       └── cli.js              node cli.js product --retailer x --url y
│   │
│   ├── worker/                     consumes queues                [Phase 3]
│   │   ├── package.json
│   │   └── src/
│   │       ├── main.js
│   │       └── processors/
│   │           ├── ingest.processor.js      payload → normalise → upsert offer
│   │           ├── match.processor.js       offer → canonical product
│   │           ├── refresh.processor.js     re-price one offer
│   │           ├── alert.processor.js       evaluate + trigger + notify
│   │           └── retention.processor.js   downsample + prune history
│   │
│   └── scheduler/                  cron → enqueue ONLY            [Phase 5]
│       ├── package.json
│       └── src/
│           ├── main.js
│           └── schedules/
│               ├── refresh.schedule.js      the tiered candidate selector
│               ├── health.schedule.js       one canary fetch per retailer
│               └── retention.schedule.js
│
├── packages/                       ← shared. no side effects on import.
│   │
│   ├── contracts/                  ← THE source of truth for every shape
│   │   └── src/
│   │       ├── offer.schema.js         zod: RawOffer
│   │       ├── product.schema.js       zod: CanonicalProduct
│   │       ├── job.schema.js           zod: ScrapeJob · ScrapeResult
│   │       ├── retailers.js            the retailer registry + metadata
│   │       └── index.js
│   │
│   ├── core/                       ← pure functions. no I/O. no framework.
│   │   └── src/
│   │       ├── money.js                paise helpers · INR formatting
│   │       ├── result.js               ok() / err() / isOk()
│   │       ├── errors.js               AppError + the error taxonomy
│   │       ├── similarity.js           title token scoring
│   │       ├── model-code.js           extract "SM-S928B" from a title
│   │       ├── normalise.js            title/brand/unit canonicalisation
│   │       └── url.js                  canonicalise · strip tracking params
│   │
│   ├── db/
│   │   └── src/
│   │       ├── connect.js
│   │       ├── models/                 schema definitions ONLY
│   │       │   ├── user.model.js
│   │       │   ├── refresh-token.model.js
│   │       │   ├── product.model.js
│   │       │   ├── offer.model.js
│   │       │   ├── price-point.model.js
│   │       │   ├── product-link.model.js
│   │       │   ├── category.model.js
│   │       │   ├── wishlist.model.js
│   │       │   ├── alert.model.js
│   │       │   └── notification.model.js
│   │       └── repositories/           the ONLY code that touches models
│   │           ├── user.repo.js
│   │           ├── product.repo.js
│   │           ├── offer.repo.js
│   │           └── ...
│   │
│   ├── cache/src/index.js          get/set/del — silent no-op without Redis
│   ├── queue/src/index.js          BullMQ factories + queue name constants
│   ├── config/src/index.js         ONE zod schema for env. parsed once.
│   └── logger/src/index.js         pino + redaction + reqId
│
├── scripts/
│   ├── seed-categories.js
│   ├── create-indexes.js           run this against production. don't forget.
│   └── probe-retailer.js           recon before writing a connector
│
└── docs/
    ├── adr/                        one file per non-obvious decision
    ├── ADDING-A-CONNECTOR.md
    └── RUNBOOK.md                  what to do when it breaks at 2am
```

### Why the folders are shaped like this

**`modules/` by feature, not by type.** Everything about alerts lives in
`modules/alerts/`. The alternative — `controllers/`, `services/`, `models/`
at the top — means touching one feature makes you open five distant folders,
and it gets worse as the project grows.

**`packages/` for anything two apps share.** The alternative is copy-paste
drift, where the API and the worker slowly disagree about what an offer is.

**`core/` is pure functions only.** No database, no HTTP, no framework. That
makes it trivially testable — no mocks, no setup, no teardown. If it needs a
mock to test, it doesn't belong in `core/`.

---

## 7. Layering rules

One direction. Down only. Never sideways, never up.

```
route ──▶ middleware ──▶ controller ──▶ service ──▶ repository ──▶ model ──▶ mongo
                                          │
                                          ├──▶ cache
                                          ├──▶ queue
                                          └──▶ client (scraper, ai)
```

| Layer | May do | Must never do |
|---|---|---|
| **route** | Bind a path to middleware + one controller method | Contain any logic |
| **controller** | Read `req`, call ONE service, shape the response | Touch a repository, model, cache or queue |
| **service** | Business rules, orchestration, caching decisions | Reference `req`/`res`, or import another module's repository |
| **repository** | All Mongoose queries, projections, indexes | Contain business rules, or call another repository |
| **model** | Schema, validation, indexes, virtuals | Any I/O beyond its own collection |

**Enforce it in ESLint, not in your head.** Documented-only conventions decay
in about a sprint:

```js
// eslint.config.js
{
  files: ['apps/api/src/modules/**/*.controller.js'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [{
        group: ['**/repositories/*', '@pc/db/*'],
        message: 'Controllers call services. Services call repositories.',
      }],
    }],
  },
},
{
  files: ['apps/scraper/src/connectors/**/*.js'],
  rules: {
    'no-restricted-imports': ['error', {
      paths: ['axios', 'undici', 'node-fetch'],
      message: 'Connectors reach the network only through core/http.js — '
             + 'that is where robots, throttling and circuit breaking live.',
    }],
  },
}
```

That second rule is the important one. It means a new connector **inherits**
politeness by construction and physically cannot forget it.

---

## 8. Data model

Enough to build from. Fill in details as each phase needs them.

```
user              { _id, name, email↑, passwordHash, role, createdAt }
                  unique { email: 1 }

refresh_token     { _id, userId, tokenHash, expiresAt, revoked, replacedBy }
                  index { tokenHash: 1, revoked: 1 }
                  TTL   { expiresAt: 1 } expireAfterSeconds: 0

product           { _id, title, brand, modelCode, categoryPath[], attributes{},
                    images[], offerCount, bestPricePaise, bestOfferId,
                    priceStats{ min90, median90, max90 }, updatedAt }
                  index { brand: 1, modelCode: 1 }        ← matching lookup
                  index { categoryPath: 1, bestPricePaise: 1 }
                  text  { title: 'text', brand: 'text' }

offer             { _id, productId, retailer, externalId, url, title,
                    pricePaise, mrpPaise, inStock, images[], rating{},
                    lastScrapedAt, nextRefreshAt, refreshTier, failCount }
                  unique { retailer: 1, externalId: 1 }   ← THE upsert key
                  index  { productId: 1, pricePaise: 1 }  ← cheapest for product
                  index  { nextRefreshAt: 1, refreshTier: 1 }  ← scheduler scan

price_point       { offerId, productId, ts, pricePaise, inStock }
                  timeseries { timeField: 'ts', metaField: 'offerId' }
                  ← APPEND ONLY WHEN THE PRICE ACTUALLY CHANGES.
                    a poll finding the same price writes nothing.
                    cuts history volume ~95% and loses no information:
                    the series is a step function.

product_link      { productId, offerId, confidence, signals{}, status }
                  unique { offerId: 1 }     ← an offer belongs to ONE product
                  index  { status: 1, confidence: -1 }   ← the review queue

category          { _id, name, slug↑, path, parentId }
wishlist          { userId, productId, createdAt }   unique { userId, productId }
alert             { userId, productId, targetPricePaise, status, triggeredAt }
                  index { productId: 1, status: 1 }      ← the evaluation scan
notification      { userId, type, title, message, data{}, isRead, createdAt }
                  index { userId: 1, isRead: 1, createdAt: -1 }
                  TTL   { createdAt: 1 } 90 days
```

> **The index that decides whether this scales:**
> `offer { nextRefreshAt: 1, refreshTier: 1 }`.
> The scheduler's candidate query must be a bounded index range scan with a
> hard `.limit()` — never a collection scan, never "all stale offers". Get
> this wrong and one tick tries to re-price your entire catalog.

---

## 9. The phases

Eleven phases. Each ends with something that runs.

---

### Phase 0 — Skeleton

**Goal:** a repo where the next ten phases are easy to build, and hard to build wrongly.

**Build**
- [ ] npm workspaces root, `"type": "module"`, Node 22 in `.nvmrc`
- [ ] Folder skeleton from §6 — empty files are fine, just create the shape
- [ ] `docker-compose.yml` with mongo + redis
- [ ] `packages/config` — one zod schema for env, parsed once at import,
      `process.exit(1)` with a readable message if anything is missing
- [ ] `packages/logger` — pino, with `password`/`token`/`authorization` redacted
- [ ] `packages/core` — `money.js`, `result.js`, `errors.js`
- [ ] `apps/api` booting with `/health` and the error handler. Nothing else.
- [ ] ESLint flat config with the §7 boundary rules
- [ ] Vitest running, with one trivial passing test

**Prove it works**
```bash
docker compose up -d
npm run dev -w apps/api
curl localhost:5000/health          # → {"status":"ok"}
npm test                            # → passes
# then delete a required env var and restart — it must exit with a clear message
```

**Stop here and you have:** a runnable skeleton. Not useful yet, but every
later phase is now cheaper.

> Config validation and layering rules added later never get fully adopted.
> On day one they're free.

---

### Phase 1 — Auth

**Goal:** real users, real sessions, real revocation.

**Build**
- [ ] `user` and `refresh_token` models + repositories
- [ ] `modules/auth/` — the full routes → controller → service → schema stack
- [ ] Signup, login, refresh (**with rotation**), logout, `GET /me`
- [ ] Access token: JWT, 15 min. Refresh token: JWT **and** a DB row storing
      only its SHA-256 hash, delivered as an `httpOnly` cookie
- [ ] Rotation: every refresh revokes the old row and points it at its successor
- [ ] **Reuse detection** — a revoked token being presented means it was
      stolen. Revoke that user's whole token family and force re-login.
- [ ] `requireAuth`, `optionalAuth`, `requireRole` middleware
- [ ] Rate limits: strict on login and signup
- [ ] CORS with an explicit origin allowlist and `credentials: true`

**Prove it works**
```
signup → login → wait for the access token to expire → refresh → still works
logout → refresh with the same token → 401
replay an already-used refresh token → 401 AND the whole family is revoked
```
Write these as integration tests with `mongodb-memory-server`. You'll rerun
them constantly.

> **CORS gotcha, guaranteed to bite you:** with `credentials: true` a browser
> rejects `Access-Control-Allow-Origin: *` outright. A bare `cors()` breaks
> login in the browser while working perfectly in Postman. You must reflect
> the specific origin.

**Stop here and you have:** an auth service. Genuinely reusable in any project.

---

### Phase 2 — The scraper service

**Goal:** fetch and parse two retailers, politely, without a database.

**Build**
- [ ] `packages/contracts` — `RawOfferSchema` and `ScrapeJobSchema` in zod
- [ ] `apps/scraper` control plane: `POST /jobs`, `/health`
- [ ] **`core/http.js` first, before any connector.** Every request goes
      through it: throttle → robots → user-agent → retry with jittered
      backoff → circuit breaker → timeout
- [ ] `core/throttle.js` — ≤2 concurrent per domain, ≥1500 ms between starts
- [ ] `core/robots.js` — fetch, cache 24 h, obey. Disallowed = fail before
      any network call happens
- [ ] `core/json-ld.js` — **try `schema.org/Product` before parsing HTML.**
      Most Indian retailers publish it for SEO and it's far more stable than
      CSS selectors
- [ ] **Two connectors only.** Pick the two with the cleanest data.
- [ ] Save 4 fixture HTML files per retailer: in stock, out of stock,
      discounted, malformed
- [ ] Unit-test `parse.js` against the fixtures — it's pure, so this is easy
- [ ] `cli.js` so you can run it by hand
- [ ] The ESLint rule banning network imports inside `connectors/`

**Prove it works**
```bash
node apps/scraper/src/cli.js product --retailer flipkart --url <real-url>
# → a zod-valid RawOffer

node apps/scraper/src/cli.js product --retailer flipkart --url <disallowed-path>
# → fails with ROBOTS_DISALLOWED, and makes NO network request

npm test -w apps/scraper    # fixture tests pass
```

**Stop here and you have:** a working CLI scraper. Useful on its own.

> **Build `core/http.js` before the connectors, not after.** Retrofitting
> throttling into three existing connectors means finding three bypasses.
> Building it first means bypasses are impossible.

---

### Phase 3 — Products, offers and matching

**Goal:** listings become products. This is the heart of the whole thing.

**Build**
- [ ] `product`, `offer`, `product_link` models with every index from §8
- [ ] `apps/worker` + BullMQ; the `ingest` processor
- [ ] Wire the scraper's queue sink → worker → mongo
- [ ] Matching, in this order:
  1. **Normalise** — lowercase, strip punctuation, `128gb` → `128 gb`,
     canonicalise brand aliases, strip noise like `(Refurbished)`
  2. **Extract** — model code (`SM-S928B`, `A3092`), brand, category
  3. **Block** — candidates where `brand` matches AND
     (`modelCode` matches OR same category branch). Never a full scan.
  4. **Score** — see below
  5. **Gate** — see below
  6. **Decide** — ≥0.86 auto-link · 0.62–0.86 review queue · <0.62 new product
- [ ] Maintain `product.bestPricePaise` and `bestOfferId` on every offer write

**Scoring**
```
confidence = 0.40·modelCode + 0.30·titleSimilarity + 0.20·attributes + 0.10·brand
```

**The gates — build these FIRST, before tuning any weight.** Any one of them
rejects the match outright regardless of score:

| Gate | Rule | Stops |
|---|---|---|
| **Price ratio** | `0.35 ≤ ratio ≤ 2.8` | A ₹1,30,000 phone matched to its ₹299 case. **The highest-value gate by far.** |
| Title similarity | `≥ 0.45` | A shared model code linking unrelated items |
| Category | Same top-level branch | A book matched to an appliance because both say "Samsung" |
| Variant | No contradicting facet | 128 GB matched to 256 GB |
| Refurbished | Flags must agree | A refurb unit showing as a great deal on a new product |

**Prove it works**
```
ingest the same phone from 2 retailers
→ ONE product, TWO offers, correct bestPricePaise

try to match a phone against its own case
→ REJECTED by the price gate
```
Then hand-label ~50 pairs and check precision. Aim for ≥95%.

**Stop here and you have:** the core data asset. Everything else reads from it.

> **A conservative matcher that under-links** = fewer comparisons shown.
> Annoying, fixable.
> **A loose matcher that over-links** = wrong prices shown to users.
> Nobody trusts it again, and later tuning doesn't undo the damage.
> When unsure, don't link.

---

### Phase 4 — The public read API ★

**Goal:** something a frontend can be built against. **This is a working price comparison site.**

**Build**
- [ ] `GET /api/products/:id` — product + all offers, cheapest first
- [ ] `GET /api/search?q=` — Mongo text index, paginated, sortable.
      **Reads the database.** If coverage is thin, enqueue a discovery job
      and return what you have.
- [ ] `GET /api/categories` and `GET /api/categories/:slug/products`
- [ ] `POST /api/compare-url` — the signature endpoint:
  - canonicalise the URL, strip tracking params
  - **allowlist the host** — reject anything not a known retailer
  - find or create the offer, resolve its product, return sibling offers
  - single-flight lock (`SET NX PX 20s`) so a viral product doesn't cause
    N identical expensive misses
- [ ] Response envelope: `{ success, data, meta }` — one shape, always
- [ ] `meta.degraded: []` naming any retailer that didn't answer

**Prove it works**
```
paste a real Flipkart URL
→ that product + genuinely cheaper alternatives from other retailers
→ under 2.5 s
```

**Stop here and you have:** ★ **a real product.** Build a frontend against it
if you want. Everything after this is improvement, not foundation.

> **SSRF — do this now, not later.** `/compare-url` takes a user-supplied URL
> and makes a server-side request with it. Without the host allowlist,
> someone passes `http://169.254.169.254/` and reads your cloud credentials.
> The allowlist ships **with** the endpoint.

---

### Phase 5 — Price history

**Goal:** track prices over time, without drowning the database or getting IP-banned.

**Build**
- [ ] `price_point` as a Mongo **time-series** collection
- [ ] Write a point **only when the price actually changed**
- [ ] `product.priceStats` — 90-day min/median/max, refreshed on price writes
- [ ] `apps/scheduler` with the tiered refresh selector:

| Tier | What | How often |
|---|---|---|
| A | Has an active alert | 1 h |
| B | On someone's wishlist | 6 h |
| C | Viewed in the last 7 days | 24 h |
| D | Everything else | 72 h |

- [ ] **Hard cap `REFRESH_BATCH_MAX` per tick** (start at 200)
- [ ] Per-retailer Redis token bucket — shared across all workers, so adding
      workers can't increase outbound traffic
- [ ] `GET /api/products/:id/history?range=90d`

**Prove it works**
```
run the scheduler → jobs appear in the queue, worker consumes them
change a price manually → exactly ONE new price_point
run again with no change → ZERO new points
watch outbound requests per retailer per minute → within budget
```

**Stop here and you have:** price charts. The thing that makes people come back.

> Verify all three brakes independently: (1) the scheduler only enqueues,
> (2) the token bucket holds under 3 workers, (3) the batch cap holds. Any
> one failing still leaves two.

---

### Phase 6 — Wishlist and alerts

**Goal:** the retention loop.

**Build**
- [ ] Wishlist CRUD; adding an item promotes its offers to refresh tier B
- [ ] `POST /api/alerts { productId, targetPrice }`
      → **400 if the target is at or above the current price** (it would fire
      instantly, which isn't what the user meant)
- [ ] Alerts attach to the **product**, not one retailer's listing — so it
      fires when *anyone* drops, and survives that listing being delisted
- [ ] The `alert` processor runs right after each price write, not as a
      separate scan
- [ ] Trigger atomically:

```js
// two workers must not both send this notification
const alert = await Alert.findOneAndUpdate(
  { _id, status: 'active' },        // ← the guard IS the lock
  { status: 'triggered', triggeredAt: new Date(), triggeredPricePaise },
  { new: true }
);
if (!alert) return;                 // someone else got it. we're done.
```

**Prove it works**
```
set an alert below the current price → drop the price → it fires ONCE
run two workers against the same drop → still exactly one notification
```

**Stop here and you have:** users with a reason to return.

---

### Phase 7 — Notifications and live push

**Goal:** the user finds out immediately.

**Build**
- [ ] `notification` model + inbox endpoints (list, unread count, mark read,
      mark all read)
- [ ] **The repository is the only place a notification is created — and it
      publishes to the bus in that same function.** Then no caller can create
      one without also triggering the push. Structural, not by convention.
- [ ] `GET /api/notifications/stream` — SSE
  - auth via `?token=` (`EventSource` cannot set headers)
  - heartbeat comment every 25 s so proxies don't drop the connection
  - clean up the subscription on close
- [ ] `realtime/notification-bus.js` — Redis pub/sub when Redis is on,
      in-process EventEmitter when it isn't

**Prove it works**
```
open the SSE stream → trigger an alert from the worker → arrives in <5 s
                       (with api and worker as SEPARATE processes)
kill redis → the inbox still works, live push stops, nothing crashes
```

> **Two traps, both already paid for once:**
> 1. When Redis is on, `publish()` must **not** also emit locally. Redis
>    delivers a publisher's own message back to its own subscriber — emitting
>    both ways delivers everything twice.
> 2. Create the pub/sub connections **without** `keyPrefix`. ioredis rewrites
>    more than plain keys in some versions, and a channel name silently
>    rewritten differently on publisher vs subscriber means messages vanish
>    with no error at all.

**Stop here and you have:** the full user-facing product.

---

### Phase 8 — Admin and more retailers

**Goal:** the tools to operate it, and wider coverage.

**Build**
- [ ] Admin auth — a real `admin` role on the user, same JWT pipeline
- [ ] Curated catalog CRUD for homepage and category browsing
- [ ] Retailer enable/disable + per-retailer rate budget
- [ ] Connector health view: success rate, parse-failure rate, circuit state
- [ ] **Match review queue** — the 0.62–0.86 band. Approve or reject.
- [ ] `audit_log` — actor, action, target, before/after, on every admin write
- [ ] Connectors 3, 4 and 5 (same recipe as Phase 2 — it's mechanical now)

**Prove it works**
```
review and correct a borderline match → it updates, and appears in the audit log
disable a retailer → it disappears from search, nothing errors
```

---

### Phase 9 — Caching and resilience

**Goal:** survive traffic, and survive failures.

**Build**
- [ ] Two-tier cache: in-process LRU (L1) → Redis (L2) → database
- [ ] **Version every key prefix**: `product:v1:{id}`. A response-shape change
      ships as `:v2:` — no mass deletion, no stale-shape bugs, instant rollback.
- [ ] Cache in the **service**, not the HTTP layer, for anything paginated.
      An HTTP-level cache keyed on a URL that ignores `?page=` freezes
      whichever page was fetched first and serves it to everyone.
- [ ] Single-flight on every expensive miss
- [ ] Explicit invalidation on every write a cached read depends on
- [ ] Circuit breakers on every outbound dependency
- [ ] **Chaos drills** — kill Redis, kill the worker, block a retailer, sever
      mongo. Write down what should happen for each, then verify it does.
- [ ] Run `.explain()` on **every** production query. Any collection scan is
      a bug.

**Prove it works**
```
stop redis    → every endpoint still returns correct data, just slower
block one retailer → search still works, failure named in meta.degraded
load test     → 200 req/s per instance, p95 under 250 ms on cached reads
```

---

### Phase 10 — Production

**Goal:** live, and you find out about problems before your users do.

**Build**
- [ ] MongoDB Atlas — same region as your host, backups on, a `readWrite`-only
      user (not admin)
- [ ] `render.yaml` (or equivalent) describing everything as code
- [ ] `scripts/create-indexes.js` **run against production.** Missing indexes
      on a live catalog is the fastest route to an outage.
- [ ] Health-gated zero-downtime deploys; verify a rollback actually works
      *before* you need one
- [ ] Sentry, wired into `error-handler.js` — it's already the single place
      every error passes through
- [ ] `/metrics` — request rate, error rate, latency, queue depth, cache hit
      rate, per-retailer scrape success
- [ ] External uptime monitor hitting `/health` from outside
- [ ] `docs/RUNBOOK.md`: connector broken · queue backed up · mongo full ·
      redis lost · bad deploy
- [ ] Security pass: **`helmet`**, dependency audit, rotate every secret off
      its development value, Redis-backed rate limiting (the in-memory default
      multiplies your limits by instance count)

**Prove it works**
```
deploy → zero downtime → rollback → under 5 minutes
break a connector deliberately → you get alerted within 15 min
```

**Stop here and you have:** a live product you can operate.

---

### Phase 11 — Onward

Not a phase. A list of what's next, in rough value order.

- Affiliate links + click attribution — **revenue, and simultaneously the most
  stable data source you can have**
- Migrate your busiest retailers from scraping to official affiliate APIs
- Image pHash as a 5th matching signal (great for fashion and cosmetics,
  where titles diverge wildly)
- A learned matching re-ranker trained on your accumulated review-queue
  decisions — this is exactly why `product_link.signals{}` gets persisted
- OpenSearch, once Mongo text relevance stops being good enough (~1M products)
- Email and web push alongside SSE
- Browser extension — compare prices on the retailer's own page

---

## 10. Milestone map

```
Phase 0  Skeleton
   │
Phase 1  Auth ─────────────┐
   │                       │  (these two are independent —
Phase 2  Scraper ──────────┘   do them in either order)
   │
Phase 3  Products + Offers + MATCHING      ← the core asset
   │
Phase 4  Public read API                   ★ A WORKING PRODUCT
   │
Phase 5  Price history
   │
Phase 6  Wishlist + Alerts
   │
Phase 7  Notifications + SSE               ★ FULL USER-FACING PRODUCT
   │
Phase 8  Admin + more retailers
   │
Phase 9  Caching + resilience
   │
Phase 10 Production                        ★ LIVE
   │
Phase 11 Affiliate revenue · ML matching · scale
```

**Three points where you can genuinely stop and have something:**

| After | You have |
|---|---|
| **Phase 4** | A working price comparison site. Build a frontend, show people. |
| **Phase 7** | The complete user-facing product — accounts, alerts, live notifications. |
| **Phase 10** | Live, monitored, operable. |

---

## 11. Definition of done

A phase isn't finished until all of these are true. Partial completion is
exactly how a system ends up half-wired — which is what the phasing exists to
prevent.

- [ ] Every new endpoint validates body, query and params with zod
- [ ] Every new service function has a unit test
- [ ] Every new endpoint has an integration test
- [ ] Every new query has been through `.explain()` and uses an index
- [ ] Every external call has a timeout and a documented degraded behaviour
- [ ] Every new env var is in `.env.example` **and** the config schema
- [ ] Every error path returns the standard `{ success: false, error }` envelope
- [ ] Every non-obvious decision has a `// why:` comment or an ADR
- [ ] `npm test` and `npm run lint` both pass
- [ ] The phase's "Prove it works" check passes on a clean start

---

## Quick reference

**Non-negotiables** — the things worth being rigid about:

| # | Rule |
|---|---|
| 1 | Integer paise. Never float money. |
| 2 | zod at every boundary. It's your type system. |
| 3 | The API never scrapes during a request. |
| 4 | The scheduler only enqueues. It never does work. |
| 5 | Connectors reach the network only through `core/http.js`. |
| 6 | Price gate before match confidence. Always. |
| 7 | `Promise.allSettled`, never `Promise.all`, for retailer fan-out. |
| 8 | Redis down = slower, never broken. |
| 9 | `/health` touches nothing that can fail for a business reason. |
| 10 | Comment *why*, never *what*. |

**Traps already paid for once — don't pay again:**

- A scheduler with catch-up semantics fires a full batch of live fetches on
  every restart
- `cors()` with no options breaks browser login while Postman works fine
- Caching a paginated response by URL alone freezes page 1 for everyone
- Redis pub/sub double-delivers if you also emit locally
- `keyPrefix` on a pub/sub connection silently breaks channel names
- A missing `.limit()` on the refresh query re-prices your entire catalog
