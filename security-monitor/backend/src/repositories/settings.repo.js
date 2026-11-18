'use strict';
const db = require('../config/mysql');
const { parseJson } = require('../utils/json');

async function getAll() {
  const rows = await db.query('SELECT setting_key, setting_value FROM security_settings');
  const out = {};
  for (const r of rows) out[r.setting_key] = parseJson(r.setting_value);
  return out;
}

async function upsert(key, value, updatedBy) {
  await db.query(
    `INSERT INTO security_settings (setting_key, setting_value, updated_by) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)`,
    [key, JSON.stringify(value), updatedBy || null]
  );
}

module.exports = { getAll, upsert };
