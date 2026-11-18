# Self-testing the security monitor

## 1. Start services

Follow [`README.md`](./README.md) to start MySQL and Redis, run migrations, create an admin, and start both services. The API is at `http://localhost:5005`; start the independent frontend with `npm run dev` from `security-monitor/frontend` and open `http://localhost:5174`.

To test actual app telemetry, also configure the main app as described in [`INTEGRATION.md`](./INTEGRATION.md), enable `SECURITY_MONITOR_ENABLED=true`, restart the price-comparison API on port 4995, and keep `SECURITY_ENFORCE_BLOCKS=false`.

## 2. Run the monitor tests

From the repository root, run the focused Jest/Supertest suites:

```
npm run test:security-monitor
```

The backend and frontend packages also expose `npm test` scripts for running the same monitor suites.

## 3. Test detections with synthetic events

These are safe, signed events sent directly to the monitor. They use a TEST-NET IP and do not send requests to the price-comparison app:

```
npm run simulate -- brute-force
npm run simulate -- scan
npm run simulate -- rate
npm run simulate -- urls
npm run simulate -- unauthorized
npm run simulate -- normal
npm run simulate -- mixed
```

Expected: suspicious scenarios create alerts visible in **Alerts**, **Events**, and **Failed Logins**; severe detections add the simulator IP to **Blocked IPs**. `normal` should not generate an alert. The API's signed blocklist endpoint also returns this temporary block.

## 4. Test live events from the app

With the main app and monitor running, send five failed login requests to the app (PowerShell):

```
1..5 | ForEach-Object {
  try {
    Invoke-RestMethod -Method Post `
      -Uri http://127.0.0.1:4995/api/auth/login `
      -ContentType 'application/json' `
      -Body '{"email":"monitor-test@example.com","password":"definitely-wrong"}' `
      -ErrorAction Stop
  } catch {
    if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { $_.Exception.Message }
  }
}
```

Then refresh **Failed Logins** and **Alerts**. You should see the failures plus a medium-severity brute-force/account-targeting alert. The monitor stores only a keyed hash of the account identifier, not the email/password. Requests from localhost are allowlisted, so they should not block your machine.

You can also send several requests to an unsupported compare URL to exercise URL-rejection telemetry; do not use a real internal/private service URL. The submitted URL is not forwarded to the monitor.

## 5. Verify temporary blocking safely

The synthetic `brute-force`, `scan`, or `rate` scenarios should add a non-private test address to the monitor blocklist. By default, the main API only reports events and **does not enforce** blocks. To check enforcement safely, use a test client/IP that is not allowlisted and never your own loopback/private IP. Set `SECURITY_ENFORCE_BLOCKS=true` only after verifying the blocklist and confirming your own administration IP is allowlisted; restart the main API. Set it back to `false` to stop enforcement.

## Expected security checks

- Invalid, old, tampered, or replayed HMAC signatures are rejected; duplicate event IDs are idempotent.
- Monitor API mutations require the CSRF header; dashboard API and Socket.IO reject unauthenticated access.
- Repeated login failures alert and eventually trigger a temporary IP block (unless the IP is allowlisted). Account-targeted alerts never block an account, avoiding account lockout attacks.
- Loopback and private ranges cannot be automatically blocked.
