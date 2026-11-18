'use strict';
const net = require('net');

/** Returns a canonical IP string, or null if invalid. Strips IPv4-mapped IPv6 (::ffff:1.2.3.4). */
function normalizeIp(raw) {
  if (typeof raw !== 'string') return null;
  let v = raw.trim().toLowerCase();
  if (v.startsWith('::ffff:') && net.isIPv4(v.slice(7))) v = v.slice(7);
  return net.isIP(v) ? v : null;
}

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

/** allowlist entries: single IPs or IPv4 CIDRs. */
function isAllowlisted(ip, allowlist = []) {
  for (const entry of allowlist) {
    if (entry === ip) return true;
    if (entry.includes('/') && net.isIPv4(ip)) {
      const [base, bitsStr] = entry.split('/');
      const bits = Number(bitsStr);
      if (!net.isIPv4(base) || !(bits >= 0 && bits <= 32)) continue;
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      if ((ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask)) return true;
    }
  }
  return false;
}

module.exports = { normalizeIp, isAllowlisted };
