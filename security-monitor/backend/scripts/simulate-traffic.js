'use strict';
/**
 * DEV/TEST ONLY. Sends signed fake events to the monitor so you can watch detection work.
 *   npm run simulate -- <scenario> [ip]
 * scenarios: normal | brute-force | scan | rate | urls | unauthorized | mixed
 * Uses a TEST-NET address (203.0.113.x) by default because loopback/private IPs are allowlisted and never blocked.
 */
require('dotenv').config();
const crypto = require('crypto');

if (process.env.NODE_ENV === 'production') { console.error('Refusing to run in production.'); process.exit(1); }

const BASE = process.env.SECURITY_MONITOR_URL || `http://127.0.0.1:${process.env.PORT || 5005}`;
const SECRET = process.env.SERVICE_HMAC_SECRET;
if (!SECRET) { console.error('SERVICE_HMAC_SECRET missing in .env'); process.exit(1); }

const scenario = process.argv[2] || 'mixed';
const ip = process.argv[3] || '203.0.113.50';
const id = () => crypto.randomUUID();
const acct = (n) => crypto.createHmac('sha256', 'pepper').update(n).digest('hex');
const access = (o) => ({ type: 'access', eventId: id(), ts: new Date().toISOString(), ip, method: 'GET', status: 200, durationMs: 12 + Math.random() * 40, userAgent: 'sim/1.0', routeMatched: true, ...o });

const scenarios = {
  normal: () => Array.from({ length: 30 }, (_, i) => access({ path: ['/api/alerts', '/api/wishlist', '/api/notifications'][i % 3] })),
  'brute-force': () => Array.from({ length: 12 }, () => [
    { type: 'auth', eventId: id(), ts: new Date().toISOString(), ip, outcome: 'failure', accountHash: acct('victim@example.com'), path: '/api/auth/login' },
    access({ method: 'POST', path: '/api/auth/login', status: 401, route: '/api/auth/login' }),
  ]).flat(),
  scan: () => ['/.env', '/.git/config', '/wp-admin', '/phpmyadmin', '/admin', '/backup.zip', ...Array.from({ length: 20 }, (_, i) => `/x${i}.php`)]
    .map((p) => access({ path: p, status: 404, routeMatched: false })),
  rate: () => Array.from({ length: 150 }, () => access({ path: '/api/products/6afc39451a29478e01ee84cf' })),
  urls: () => Array.from({ length: 8 }, (_, i) => ({ type: 'url_rejected', eventId: id(), ts: new Date().toISOString(), ip, reason: i % 2 ? 'ssrf_blocked' : 'invalid_url', host: i % 2 ? '169.254.169.254' : 'bad host' })),
  unauthorized: () => Array.from({ length: 35 }, () => access({ path: '/api/alerts', status: 401 })),
};
scenarios.mixed = () => [...scenarios.normal(), ...scenarios['brute-force'](), ...scenarios.scan(), ...scenarios.urls()];

async function send(events) {
  const path = '/internal/events';
  const body = Buffer.from(JSON.stringify({ events }));
  const ts = String(Date.now());
  const nonce = crypto.randomBytes(16).toString('hex');
  const sig = crypto.createHmac('sha256', SECRET).update(`${ts}\n${nonce}\nPOST\n${path}\n${crypto.createHash('sha256').update(body).digest('hex')}`).digest('hex');
  const res = await fetch(BASE + path, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-sm-timestamp': ts, 'x-sm-nonce': nonce, 'x-sm-signature': sig } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

(async () => {
  if (!scenarios[scenario]) { console.error(`Unknown scenario. Use: ${Object.keys(scenarios).join(', ')}`); process.exit(1); }
  const events = scenarios[scenario]();
  for (let i = 0; i < events.length; i += 50) {
    const r = await send(events.slice(i, i + 50));
    console.log(`batch ${i / 50 + 1}: HTTP ${r.status}`, JSON.stringify(r.body));
  }
  console.log(`Sent ${events.length} "${scenario}" events from ${ip}.`);
})().catch((e) => { console.error(e.message); process.exit(1); });
