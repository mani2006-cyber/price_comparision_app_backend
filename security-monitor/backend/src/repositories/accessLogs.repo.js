'use strict';
const db = require('../config/mysql');

/** INSERT IGNORE + UNIQUE(event_uid): a retried batch can never create duplicate rows. */
async function bulkInsert(events) {
  if (!events.length) return 0;
  const values = events.map((e) => [e.eventId, e.ts, e.ip, e.method, e.endpoint, e.status,
    Math.round(e.durationMs * 100) / 100, e.kind, e.userAgent ? String(e.userAgent).slice(0, 255) : null, e.blocked ? 1 : 0]);
  const r = await db.query(
    `INSERT IGNORE INTO access_logs (event_uid, ts, ip, method, endpoint, status_code, response_time_ms, kind, user_agent, blocked) VALUES ?`,
    [values]);
  return r.affectedRows;
}

async function topIps({ since, metric = 'requests', limit = 10 }) {
  let rows;
  if (metric === 'failed_logins') {
    rows = await db.query(`SELECT ip, COUNT(*) AS count, MAX(created_at) AS last_seen FROM security_events
      WHERE event_type = 'FAILED_LOGIN' AND created_at >= ? GROUP BY ip ORDER BY count DESC LIMIT ?`, [since, limit]);
  } else if (metric === 'suspicious') {
    rows = await db.query(`SELECT ip, COUNT(*) AS count, MAX(created_at) AS last_seen FROM security_events
      WHERE event_type NOT IN ('FAILED_LOGIN','IP_UNBLOCKED') AND created_at >= ? GROUP BY ip ORDER BY count DESC LIMIT ?`, [since, limit]);
  } else {
    rows = await db.query(`SELECT ip, COUNT(*) AS count, SUM(status_code >= 400) AS errors, MAX(ts) AS last_seen
      FROM access_logs WHERE ts >= ? AND kind <> 'preflight' GROUP BY ip ORDER BY count DESC LIMIT ?`, [since, limit]);
  }
  return rows.map((r) => ({ ip: r.ip, count: Number(r.count), errors: r.errors === undefined ? undefined : Number(r.errors || 0),
    lastSeen: new Date(r.last_seen).toISOString() }));
}

async function topEndpoints({ since, limit = 10 }) {
  const rows = await db.query(`SELECT endpoint, COUNT(*) AS requests, SUM(status_code >= 400) AS errors,
      AVG(CASE WHEN kind = 'normal' THEN response_time_ms END) AS avg_ms, MAX(ts) AS last_seen
    FROM access_logs WHERE ts >= ? AND kind <> 'preflight' GROUP BY endpoint ORDER BY requests DESC LIMIT ?`, [since, limit]);
  return rows.map((r) => ({ endpoint: r.endpoint, requests: Number(r.requests), errors: Number(r.errors || 0),
    avgMs: r.avg_ms === null ? null : Math.round(Number(r.avg_ms) * 10) / 10, lastSeen: new Date(r.last_seen).toISOString() }));
}

async function deleteOlderThan(date, limit = 5000) {
  return (await db.query('DELETE FROM access_logs WHERE ts < ? LIMIT ?', [date, limit])).affectedRows;
}

module.exports = { bulkInsert, topIps, topEndpoints, deleteOlderThan };
