'use strict';
/** mysql2 returns JSON columns already parsed on MySQL, but as strings on MariaDB. Handle both. */
function parseJson(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
}
module.exports = { parseJson };
