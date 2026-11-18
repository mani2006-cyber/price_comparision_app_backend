'use strict';
const db = require('../config/mysql');
const { parseJson } = require('../utils/json');

async function insert(a) {
  await db.query(
    `INSERT INTO admin_audit_logs (created_at, admin_id, admin_username, action, target, ip, details) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [new Date(), a.adminId || null, a.adminUsername || null, a.action, a.target ? String(a.target).slice(0, 255) : null,
      a.ip || null, a.details ? JSON.stringify(a.details) : null]);
}

async function list({ page = 1, pageSize = 25 }) {
  const [{ total }] = await db.query('SELECT COUNT(*) AS total FROM admin_audit_logs');
  const rows = await db.query('SELECT * FROM admin_audit_logs ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?', [pageSize, (page - 1) * pageSize]);
  return { items: rows.map((r) => ({ id: Number(r.id), timestamp: new Date(r.created_at).toISOString(), adminUsername: r.admin_username,
    action: r.action, target: r.target, ip: r.ip, details: parseJson(r.details) })), total: Number(total), page, pageSize };
}

async function deleteOlderThan(date, limit = 5000) {
  return (await db.query('DELETE FROM admin_audit_logs WHERE created_at < ? LIMIT ?', [date, limit])).affectedRows;
}

module.exports = { insert, list, deleteOlderThan };
