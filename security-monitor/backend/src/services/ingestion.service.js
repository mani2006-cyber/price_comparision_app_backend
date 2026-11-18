'use strict';
/**
 * Event ingestion pipeline (at-least-once delivery + idempotency = no loss, no duplicates):
 *  validate -> dedupe by eventId (Redis NX) -> normalize -> access_logs insert -> stats buckets -> rules -> live feed.
 * If anything fails after dedupe, the dedupe keys are released so the agent's retry is processed again.
 */
const { redis } = require('../config/redis');
const K = require('../utils/redisKeys');
const { endpointFor, normalizePath } = require('../utils/endpointNormalizer');
const { eventSchema } = require('../validators/eventSchema');
const accessRepo = require('../repositories/accessLogs.repo');
const settingsService = require('./settings.service');
const statsService = require('./stats.service');
const ruleEngine = require('./ruleEngine');
const broadcaster = require('../realtime/broadcaster');
const logger = require('../utils/logger');

const STALE_MS = 5 * 60 * 1000;   // older events are stored but do not trigger rules/blocks
const DEDUPE_TTL = 3600;

function parseTs(s) {
  const now = Date.now();
  const t = s ? Date.parse(s) : NaN;
  if (!Number.isFinite(t) || t > now + 60000) return new Date(now);
  return new Date(t);
}

function prepare(ev) {
  const ts = parseTs(ev.ts);
  if (ev.type === 'access') {
    const endpoint = endpointFor(ev);
    const kind = ev.method === 'OPTIONS' ? 'preflight' : (ev.streaming || endpoint.endsWith('/stream') ? 'stream' : 'normal');
    return { ...ev, ts, endpoint, kind };
  }
  return { ...ev, ts, endpoint: ev.path ? normalizePath(ev.path) : null };
}

async function ingest(rawEvents) {
  let rejected = 0;
  const parsed = [];
  for (const raw of rawEvents) {
    const r = eventSchema.safeParse(raw);
    if (r.success) parsed.push(r.data); else rejected++;
  }
  if (!parsed.length) return { accepted: 0, duplicates: 0, rejected };

  // 1. dedupe
  const p = redis.pipeline();
  parsed.forEach((e) => p.set(K.dedupe(e.eventId), '1', 'EX', DEDUPE_TTL, 'NX'));
  const res = await p.exec();
  const fresh = [];
  parsed.forEach((e, i) => { if (res[i][0]) throw res[i][0]; if (res[i][1] === 'OK') fresh.push(e); });
  const duplicates = parsed.length - fresh.length;
  if (!fresh.length) return { accepted: 0, duplicates, rejected };

  try {
    const events = fresh.map(prepare);
    const detection = await settingsService.getDetection();
    const ctx = { detection };

    await accessRepo.bulkInsert(events.filter((e) => e.type === 'access'));

    const acc = statsService.createAccumulator();
    const now = Date.now();
    for (const ev of events) {
      let suspicious = false;
      const stale = now - ev.ts.getTime() > STALE_MS;
      if (!stale && !(ev.type === 'access' && ev.blocked)) ({ suspicious } = await ruleEngine.run(ev, ctx));
      acc.add(ev, suspicious);
      if (ev.type === 'access' && ev.kind !== 'preflight') {
        broadcaster.queueTraffic({ ts: ev.ts.toISOString(), ip: ev.ip, method: ev.method, endpoint: ev.endpoint,
          status: ev.status, ms: Math.round(ev.durationMs), kind: ev.kind, suspicious, blocked: !!ev.blocked });
      }
    }
    await acc.flush();
    return { accepted: events.length, duplicates, rejected };
  } catch (err) {
    // release dedupe keys so the retry is not dropped as a duplicate
    await redis.del(...fresh.map((e) => K.dedupe(e.eventId))).catch(() => {});
    logger.error({ err: err.message }, 'ingestion failed');
    throw err;
  }
}

module.exports = { ingest };
