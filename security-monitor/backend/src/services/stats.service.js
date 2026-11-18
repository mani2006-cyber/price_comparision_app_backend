'use strict';
/** Real-time stats = one small Redis hash per minute (26h TTL). Charts/cards read ONLY these, never MySQL. */
const { redis } = require('../config/redis');
const K = require('../utils/redisKeys');
const alertsRepo = require('../repositories/alerts.repo');

const RANGES = { '15m': { minutes: 15, step: 1 }, '1h': { minutes: 60, step: 1 }, '6h': { minutes: 360, step: 5 }, '24h': { minutes: 1440, step: 15 } };
const BUCKET_TTL_SEC = 26 * 3600;
const RECENT_MAX = 200;
const minuteOf = (ms) => Math.floor(ms / 60000);
const n = (v) => Number(v || 0);

function createAccumulator() {
  const buckets = new Map();
  const recent = [];
  return {
    add(ev, suspicious) {
      const min = minuteOf(ev.ts.getTime());
      if (!buckets.has(min)) buckets.set(min, {});
      const b = buckets.get(min);
      const inc = (f, v = 1) => { b[f] = (b[f] || 0) + v; };
      if (ev.type === 'access') {
        if (ev.kind === 'preflight') { inc('preflight'); return; }
        inc('req');
        const m = ev.method.toLowerCase();
        inc(['get', 'post', 'put', 'delete'].includes(m) ? `m_${m}` : 'm_other');
        inc(`s${Math.floor(ev.status / 100)}`);
        if (ev.kind === 'normal') { inc('rt_sum', Math.round(ev.durationMs)); inc('rt_cnt'); }
        if (ev.blocked) inc('blocked_req');
        recent.push(JSON.stringify({ ts: ev.ts.toISOString(), ip: ev.ip, method: ev.method, endpoint: ev.endpoint,
          status: ev.status, ms: Math.round(ev.durationMs), kind: ev.kind, suspicious: !!suspicious, blocked: !!ev.blocked }));
      } else if (ev.type === 'auth' && ev.outcome === 'failure') {
        inc('failed_login');
      }
      if (suspicious) inc('susp');
    },
    async flush() {
      if (!buckets.size && !recent.length) return;
      const p = redis.pipeline();
      for (const [min, fields] of buckets) {
        const key = K.statsMin(min);
        for (const [f, v] of Object.entries(fields)) p.hincrby(key, f, v);
        p.expire(key, BUCKET_TTL_SEC);
      }
      if (recent.length) { p.lpush(K.recent, ...recent.reverse()); p.ltrim(K.recent, 0, RECENT_MAX - 1); }
      const res = await p.exec();
      for (const [err] of res) if (err) throw err;
    },
  };
}

async function getTraffic(rangeKey = '1h') {
  const key = RANGES[rangeKey] ? rangeKey : '1h';
  const cfg = RANGES[key];
  const nowMin = minuteOf(Date.now());
  const mins = [];
  for (let i = cfg.minutes - 1; i >= 0; i--) mins.push(nowMin - i);
  const p = redis.pipeline();
  mins.forEach((m) => p.hgetall(K.statsMin(m)));
  const res = await p.exec();
  for (const [err] of res) if (err) throw err;

  const series = [];
  const totals = { requests: 0, suspicious: 0, failedLogins: 0, blockedRequests: 0, preflight: 0,
    methods: { GET: 0, POST: 0, PUT: 0, DELETE: 0, OTHER: 0 }, status: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 } };
  let rtSum = 0; let rtCnt = 0; let peakRpm = 0; let lastComplete = 0;

  for (let i = 0; i < mins.length; i += cfg.step) {
    const pt = { t: new Date(mins[i] * 60000).toISOString(), requests: 0, suspicious: 0, failedLogins: 0, blocked: 0, avgMs: 0,
      get: 0, post: 0, put: 0, delete: 0, other: 0, s2: 0, s3: 0, s4: 0, s5: 0 };
    let pSum = 0; let pCnt = 0;
    for (let j = i; j < Math.min(i + cfg.step, mins.length); j++) {
      const h = res[j][1] || {};
      pt.requests += n(h.req); pt.suspicious += n(h.susp); pt.failedLogins += n(h.failed_login); pt.blocked += n(h.blocked_req);
      pt.get += n(h.m_get); pt.post += n(h.m_post); pt.put += n(h.m_put); pt.delete += n(h.m_delete); pt.other += n(h.m_other);
      pt.s2 += n(h.s2); pt.s3 += n(h.s3); pt.s4 += n(h.s4); pt.s5 += n(h.s5);
      pSum += n(h.rt_sum); pCnt += n(h.rt_cnt); totals.preflight += n(h.preflight);
      peakRpm = Math.max(peakRpm, n(h.req));
      if (j === mins.length - 2) lastComplete = n(h.req);
    }
    pt.avgMs = pCnt ? Math.round((pSum / pCnt) * 10) / 10 : 0;
    rtSum += pSum; rtCnt += pCnt;
    totals.requests += pt.requests; totals.suspicious += pt.suspicious; totals.failedLogins += pt.failedLogins; totals.blockedRequests += pt.blocked;
    totals.methods.GET += pt.get; totals.methods.POST += pt.post; totals.methods.PUT += pt.put; totals.methods.DELETE += pt.delete; totals.methods.OTHER += pt.other;
    totals.status['2xx'] += pt.s2; totals.status['3xx'] += pt.s3; totals.status['4xx'] += pt.s4; totals.status['5xx'] += pt.s5;
    series.push(pt);
  }
  return { range: key, stepMinutes: cfg.step, series,
    totals: { ...totals, avgResponseMs: rtCnt ? Math.round((rtSum / rtCnt) * 10) / 10 : 0 },
    rpm: lastComplete, rps: Math.round((lastComplete / 60) * 100) / 100, peakRpm };
}

async function getRecent(limit = 100) {
  const rows = await redis.lrange(K.recent, 0, Math.min(limit, RECENT_MAX) - 1);
  return rows.map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
}

let openCache = { at: 0, value: 0 };
async function countOpenAlerts() {
  if (Date.now() - openCache.at < 5000) return openCache.value;
  try { openCache = { at: Date.now(), value: await alertsRepo.countOpen() }; } catch { /* keep old */ }
  return openCache.value;
}
const invalidateOpenAlerts = () => { openCache.at = 0; };
const countActiveBlocks = () => redis.zcount(K.blockedZset, Date.now(), '+inf');

async function buildStats(traffic) {
  const [blocked, open] = await Promise.all([countActiveBlocks(), countOpenAlerts()]);
  return { range: traffic.range, totalRequests: traffic.totals.requests, suspiciousRequests: traffic.totals.suspicious,
    failedLogins: traffic.totals.failedLogins, blockedIps: Number(blocked), openAlerts: open, rpm: traffic.rpm, rps: traffic.rps,
    avgResponseMs: traffic.totals.avgResponseMs, generatedAt: new Date().toISOString() };
}

const getStats = async (rangeKey = '1h') => buildStats(await getTraffic(rangeKey));
async function getTick() {
  const traffic = await getTraffic('1h');
  return { range: '1h', stats: await buildStats(traffic), series: traffic.series };
}

module.exports = { RANGES, createAccumulator, getTraffic, getRecent, getStats, getTick, countActiveBlocks, invalidateOpenAlerts };
