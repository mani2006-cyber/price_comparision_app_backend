# API
Base: http://localhost:5005. Auth is an HttpOnly cookie (`sm_token`). Mutating requests also need `X-Requested-With: SecurityMonitor`.

| Method | Path | Role |
|---|---|---|
| POST | /api/auth/login `{username,password}` | public (rate limited) |
| POST | /api/auth/logout, GET /api/auth/me | any |
| GET | /api/security/stats?range=15m\|1h\|6h\|24h | viewer |
| GET | /api/security/traffic, recent-traffic, events, failed-logins, top-ips, endpoints, alerts, blocked-ips | viewer |
| POST | /api/security/alerts/:id/resolve | analyst |
| POST | /api/security/blocked-ips `{ip,reason,minutes?}` | admin |
| DELETE | /api/security/blocked-ips/:ip | admin |
| GET/PUT | /api/security/settings | admin |
| GET | /api/security/audit-logs | admin |
| POST | /internal/events, GET /internal/blocklist | HMAC-signed service |

Socket.IO (same origin/cookie): event:new, alert:new, alert:resolved, block:changed, traffic:batch, stats:tick.
