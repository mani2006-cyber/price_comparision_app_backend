# Integration with the Price Comparison backend (port 4995)

The agent is already integrated at `src/security/securityMonitorAgent.js`. It requires Node 18+ and has no additional dependencies.

## Configure both `.env` files

Generate one random secret for signing agent requests, then put the exact same value in the security monitor backend and price-comparison backend. Generate a different pepper for keyed hashing of login identifiers.

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

In the price-comparison backend `.env`:

```
SECURITY_MONITOR_ENABLED=true
SECURITY_MONITOR_URL=http://127.0.0.1:5005
SERVICE_HMAC_SECRET=<same random secret as security-monitor/backend/.env>
SECURITY_MONITOR_PEPPER=<a different random secret>
SECURITY_ENFORCE_BLOCKS=false
```

In `security-monitor/backend/.env`, set the same `SERVICE_HMAC_SECRET`. The dashboard API also needs its own `JWT_SECRET`, which must be different from the HMAC secret. Keep both secrets out of source control.

Restart both backends and keep `SECURITY_ENFORCE_BLOCKS=false` while validating. The integration uses the application's `req.ip`; if deployed behind a proxy, configure Express `trust proxy` for the actual trusted proxy hops, not `true` indiscriminately.

## What is sent

- Every inbound request: IP, method, query-free path, status, duration, route-match flag, user agent, and event timestamp.
- Login successes/failures: outcome and a keyed hash of the normalized email identifier; never the email or password.
- Rejected compare URLs: rejection category and hostname only, never the submitted URL or query.

Request bodies, headers, cookies, access/refresh tokens, and raw login identifiers are never sent. Batches are HMAC-signed and retried with a bounded local spool when the monitor is unavailable. Requests continue if the monitor is down. Auto-blocks are only enforced by the main API when `SECURITY_ENFORCE_BLOCKS=true`; loopback/private IPs are allowlisted.
