'use strict';
const mysql = require('mysql2/promise');
const config = require('./env');

let pool = null;

function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      ...config.mysql,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 200,
      timezone: 'Z',
      dateStrings: false,
      charset: 'utf8mb4',
    });
  }
  return pool;
}

/** Always parameterized. Returns rows for SELECT, or the result header (insertId, affectedRows) otherwise. */
async function query(sql, params = []) {
  const [rows] = await getPool().query(sql, params);
  return rows;
}

async function ping() {
  await getPool().query('SELECT 1');
}

async function close() {
  if (pool) { await pool.end(); pool = null; }
}

module.exports = { query, ping, close, getPool };
