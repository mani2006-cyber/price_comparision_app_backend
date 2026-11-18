'use strict';
const db = require('../config/mysql');
const { parseJson } = require('../utils/json');

const toApi = (r) => ({
  id: Number(r.id), timestamp: new Date(r.created_at).toISOString(), ip: r.ip, rule: r.rule, severity: r.severity,
  title: r.title, message: r.message, status: r.status,
  resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString() : null, resolvedBy: r.resolved_by,
  eventId: r.event_id ? Number(r.event_id) : null, meta: parseJson(r.meta),
});

async function insert(a) {
  const createdAt = a.createdAt || new Date();
  const title = String(a.title).slice(0, 160); const message = String(a.message).slice(0, 500);
  const r = await db.query(
    `INSERT INTO security_alerts (created_at, ip, rule, severity, title, message, event_id, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [createdAt, a.ip, a.rule, a.severity, title, message, a.eventId || null, a.meta ? JSON.stringify(a.meta) : null]);
  return toApi({ id: r.insertId, created_at: createdAt, ip: a.ip, rule: a.rule, severity: a.severity, title, message,
    status: 'OPEN', resolved_at: null, resolved_by: null, event_id: a.eventId || null, meta: a.meta || null });
}

async function list({ status, severity, page = 1, pageSize = 25 }) {
  const where = []; const params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  if (severity && severity.length) { where.push('severity IN (?)'); params.push(severity); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [{ total }] = await db.query(`SELECT COUNT(*) AS total FROM security_alerts ${w}`, params);
  const rows = await db.query(`SELECT * FROM security_alerts ${w} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize]);
  return { items: rows.map(toApi), total: Number(total), page, pageSize };
}

async function resolve(id, by) {
  const r = await db.query(`UPDATE security_alerts SET status='RESOLVED', resolved_at=?, resolved_by=? WHERE id=? AND status='OPEN'`, [new Date(), by, id]);
  if (!r.affectedRows) return null;
  const rows = await db.query('SELECT * FROM security_alerts WHERE id = ?', [id]);
  return rows[0] ? toApi(rows[0]) : null;
}

async function findById(id) {
  const rows = await db.query('SELECT * FROM security_alerts WHERE id = ?', [id]);
  return rows[0] ? toApi(rows[0]) : null;
}

async function countOpen() {
  const [{ c }] = await db.query("SELECT COUNT(*) AS c FROM security_alerts WHERE status = 'OPEN'");
  return Number(c);
}

async function deleteOlderThan(date, limit = 5000) {
  return (await db.query('DELETE FROM security_alerts WHERE created_at < ? LIMIT ?', [date, limit])).affectedRows;
}

module.exports = { insert, list, resolve, findById, countOpen, deleteOlderThan };
