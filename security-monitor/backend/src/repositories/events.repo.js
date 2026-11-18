'use strict';
const db = require('../config/mysql');
const { parseJson } = require('../utils/json');

const toApi = (r) => ({
  id: Number(r.id), timestamp: new Date(r.created_at).toISOString(), ip: r.ip, eventType: r.event_type,
  severity: r.severity, endpoint: r.endpoint, description: r.description, action: r.action, meta: parseJson(r.meta),
});

async function insert(e) {
  const createdAt = e.createdAt || new Date();
  const description = String(e.description).slice(0, 500);
  const r = await db.query(
    `INSERT INTO security_events (created_at, ip, event_type, severity, endpoint, description, action, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [createdAt, e.ip, e.eventType, e.severity, e.endpoint || null, description, e.action || 'LOGGED', e.meta ? JSON.stringify(e.meta) : null]
  );
  return toApi({ id: r.insertId, created_at: createdAt, ip: e.ip, event_type: e.eventType, severity: e.severity,
    endpoint: e.endpoint || null, description, action: e.action || 'LOGGED', meta: e.meta || null });
}

const escapeLike = (s) => s.replace(/[\\%_]/g, '\\$&');

async function search({ from, to, severity, eventType, ip, q, page = 1, pageSize = 25 }) {
  const where = []; const params = [];
  if (from) { where.push('created_at >= ?'); params.push(from); }
  if (to) { where.push('created_at <= ?'); params.push(to); }
  if (severity && severity.length) { where.push('severity IN (?)'); params.push(severity); }
  if (eventType && eventType.length) { where.push('event_type IN (?)'); params.push(eventType); }
  if (ip) { where.push('ip LIKE ?'); params.push(`${escapeLike(ip)}%`); }
  if (q) { where.push('(description LIKE ? OR endpoint LIKE ?)'); params.push(`%${escapeLike(q)}%`, `%${escapeLike(q)}%`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [{ total }] = await db.query(`SELECT COUNT(*) AS total FROM security_events ${w}`, params);
  const rows = await db.query(`SELECT * FROM security_events ${w} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize]);
  return { items: rows.map(toApi), total: Number(total), page, pageSize };
}

async function deleteOlderThan(date, limit = 5000) {
  return (await db.query('DELETE FROM security_events WHERE created_at < ? LIMIT ?', [date, limit])).affectedRows;
}

module.exports = { insert, search, deleteOlderThan, toApi };
