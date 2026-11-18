'use strict';
const db = require('../config/mysql');

function toApi(r) {
  const expiresAt = new Date(r.expires_at);
  const live = r.status === 'ACTIVE' && expiresAt.getTime() > Date.now();
  return {
    id: Number(r.id), ip: r.ip, reason: r.reason, rule: r.rule, source: r.source, blockedBy: r.blocked_by,
    detectedAt: new Date(r.detected_at).toISOString(), durationSeconds: Number(r.duration_seconds),
    expiresAt: expiresAt.toISOString(), status: r.status === 'ACTIVE' && !live ? 'EXPIRED' : r.status,
    remainingSeconds: live ? Math.ceil((expiresAt.getTime() - Date.now()) / 1000) : 0,
    unblockedAt: r.unblocked_at ? new Date(r.unblocked_at).toISOString() : null, unblockedBy: r.unblocked_by,
  };
}

async function insert(b) {
  const r = await db.query(
    `INSERT INTO blocked_ips_history (ip, reason, rule, source, blocked_by, detected_at, duration_seconds, expires_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`,
    [b.ip, String(b.reason).slice(0, 255), b.rule || null, b.source, b.blockedBy || null, b.detectedAt, b.durationSeconds, b.expiresAt]);
  return r.insertId;
}

async function markUnblocked(ip, by) {
  return (await db.query(`UPDATE blocked_ips_history SET status='UNBLOCKED', unblocked_at=?, unblocked_by=? WHERE ip=? AND status='ACTIVE'`,
    [new Date(), by || null, ip])).affectedRows;
}

async function revert(id) {
  await db.query(`UPDATE blocked_ips_history SET status='UNBLOCKED', unblocked_at=?, unblocked_by='system' WHERE id=?`, [new Date(), id]);
}

async function expireDue(now = new Date()) {
  const due = await db.query("SELECT id, ip FROM blocked_ips_history WHERE status='ACTIVE' AND expires_at <= ?", [now]);
  if (!due.length) return [];
  await db.query("UPDATE blocked_ips_history SET status='EXPIRED' WHERE id IN (?) AND status='ACTIVE'", [due.map((d) => d.id)]);
  return [...new Set(due.map((d) => d.ip))];
}

async function list({ status = 'active', page = 1, pageSize = 25 }) {
  const where = status === 'active' ? "WHERE status='ACTIVE' AND expires_at > ?" : '';
  const params = status === 'active' ? [new Date()] : [];
  const [{ total }] = await db.query(`SELECT COUNT(*) AS total FROM blocked_ips_history ${where}`, params);
  const rows = await db.query(`SELECT * FROM blocked_ips_history ${where} ORDER BY detected_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize]);
  return { items: rows.map(toApi), total: Number(total), page, pageSize };
}

async function deleteOlderThan(date, limit = 5000) {
  return (await db.query("DELETE FROM blocked_ips_history WHERE detected_at < ? AND status <> 'ACTIVE' LIMIT ?", [date, limit])).affectedRows;
}

module.exports = { insert, markUnblocked, revert, expireDue, list, deleteOlderThan };
