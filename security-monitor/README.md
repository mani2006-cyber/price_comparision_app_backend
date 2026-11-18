# Security Monitor dashboard

Separate security dashboard for the price-comparison API. The frontend is served independently on port 5174; its API and data services run on port 5005 with MySQL and Redis.

## Requirements

Node.js 18+ and Docker Compose. The supplied Compose file runs MySQL 8.4 and Redis 7 locally; the monitor uses Redis database 5 by default to keep its keys separate from the price-comparison app.

## Start the database services

```
cd backend
Copy-Item .env.example .env
docker compose up -d --wait
docker compose ps
```

The containers bind only to `127.0.0.1`. Redis uses host port 6380 by default to avoid conflicts with a local Redis on 6379. The MySQL root password comes from `MYSQL_PASSWORD` in `backend/.env` (the example value is for local development only). Keep the named Docker volumes to preserve your database and Redis data.

## Start the monitor API

From `security-monitor/backend`:

```
npm install
```

Edit `backend/.env` with MySQL credentials and set `FRONTEND_ORIGIN=http://localhost:5174`, then generate two separate secrets of at least 32 characters:

```
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Set one as `JWT_SECRET` and another as `SERVICE_HMAC_SECRET`. Use the latter as `SERVICE_HMAC_SECRET` in the price-comparison app's `.env` too. Keep secrets private.

Then, from `security-monitor/backend`:

```
npm run migrate
npm run create-admin -- admin admin
npm start
```

The admin command prompts for a password (minimum 12 characters). The API health check is `http://localhost:5005/health`.

## Start the separate frontend

In another terminal, from `security-monitor/frontend`:

```
npm run dev
```

Open `http://localhost:5174` and sign in with the admin account created above. The frontend uses Node.js built-ins only; it needs no npm install, bundler, or native Rollup binary. Keep both URLs on `localhost` (frontend port 5174 and API port 5005) so the strict session cookie works.

## Connect the price-comparison API

Configure its `.env` with `SECURITY_MONITOR_ENABLED=true`, `SECURITY_MONITOR_URL=http://127.0.0.1:5005`, the monitor's `SERVICE_HMAC_SECRET`, and a separate `SECURITY_MONITOR_PEPPER`. Restart the main API (default port 4995). Leave `SECURITY_ENFORCE_BLOCKS=false` until detection has been verified.

See [`INTEGRATION.md`](./INTEGRATION.md) for what telemetry is sent and the proxy/IP considerations.

## Test it

Run the security-monitor Jest/Supertest suites from the repository root:

```
npm run test:security-monitor
```

For safe synthetic detections, run one scenario at a time:

```
npm run simulate -- brute-force
npm run simulate -- scan
npm run simulate -- rate
npm run simulate -- urls
npm run simulate -- unauthorized
npm run simulate -- normal
```

The simulator submits signed synthetic events from `203.0.113.x`; it does not attack the main API. Brute-force, scan, and rate scenarios should create alerts; severe threshold detections are added to the temporary block list. Loopback and private addresses are allowlisted and are not blocked.

For a live integration test, send five failed login requests to the main API from localhost and inspect **Failed Logins** and **Alerts**. Localhost is allowlisted, so this should alert without blocking your machine. Detailed steps are in [`TESTING.md`](./TESTING.md).

## API

All `/api/security/*` routes require the dashboard admin cookie; mutating calls also require `X-Requested-With: SecurityMonitor`.

- Auth: `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`
- Viewer+: stats, traffic, recent traffic, events, failed logins, top IPs, endpoints, alerts, blocked IPs
- Analyst+: resolve alerts
- Admin: block/unblock IPs, edit settings, view audit log
- Internal HMAC-signed agent endpoints: `POST /internal/events`, `GET /internal/blocklist`
- Socket.IO events: `event:new`, `alert:new`, `alert:resolved`, `block:changed`, `traffic:batch`, `stats:tick`
