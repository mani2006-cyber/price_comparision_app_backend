'use strict';
const db = require('../config/mysql');

async function findByUsername(username) {
  return (await db.query('SELECT * FROM admin_users WHERE username = ? LIMIT 1', [username]))[0] || null;
}
async function findById(id) {
  return (await db.query('SELECT * FROM admin_users WHERE id = ? LIMIT 1', [id]))[0] || null;
}
async function recordLoginSuccess(id) {
  await db.query('UPDATE admin_users SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?', [new Date(), id]);
}
async function recordLoginFailure(id, failedAttempts, lockedUntil) {
  await db.query('UPDATE admin_users SET failed_attempts = ?, locked_until = ? WHERE id = ?', [failedAttempts, lockedUntil, id]);
}
async function create({ username, passwordHash, role }) {
  return (await db.query('INSERT INTO admin_users (username, password_hash, role) VALUES (?, ?, ?)', [username, passwordHash, role])).insertId;
}

module.exports = { findByUsername, findById, recordLoginSuccess, recordLoginFailure, create };
