'use strict';
/** Applies db/migrations/*.sql in order, skipping ones already applied. Usage: npm run migrate */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const config = require('../src/config/env');

async function main() {
  const { host, port, user, password, database } = config.mysql;
  const server = await mysql.createConnection({ host, port, user, password });
  await server.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await server.end();

  const conn = await mysql.createConnection({ host, port, user, password, database, multipleStatements: true });
  await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename VARCHAR(190) NOT NULL PRIMARY KEY, applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB`);
  const [rows] = await conn.query('SELECT filename FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.filename));
  const dir = path.join(__dirname, 'migrations');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (applied.has(file)) { console.log(`skip   ${file}`); continue; }
    await conn.query(fs.readFileSync(path.join(dir, file), 'utf8'));
    await conn.query('INSERT INTO schema_migrations (filename) VALUES (?)', [file]);
    console.log(`apply  ${file}`);
  }
  await conn.end();
  console.log(`Database "${database}" is up to date.`);
}

main().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
