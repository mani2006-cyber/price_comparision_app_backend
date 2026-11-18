'use strict';
/**
 * Turns raw paths into low-cardinality endpoint names so attackers cannot create unlimited
 * Redis keys / table rows by hitting random URLs.
 *   /api/notifications/6afc5c4b349159319f63fb01/read  ->  /api/notifications/:id/read
 *   /api/wishlist/:id/                               ->  /api/wishlist/:id
 */
const MAX_LEN = 120;
const OBJECT_ID = /^[a-f0-9]{24}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC = /^\d+$/;
const LONG_HEX = /^[a-f0-9]{16,}$/i;

function normalizePath(rawPath) {
  if (typeof rawPath !== 'string') return '/unknown';
  let p = rawPath.split('?')[0].split('#')[0];
  // eslint-disable-next-line no-control-regex
  p = p.replace(/[\u0000-\u001f\u007f]/g, '');
  if (!p.startsWith('/')) p = `/${p}`;
  const parts = p.split('/').filter((s, i) => s !== '' || i === 0);
  const out = parts.map((seg) => {
    if (seg === '') return seg;
    if (seg.startsWith(':')) return ':id';
    if (OBJECT_ID.test(seg) || UUID.test(seg) || NUMERIC.test(seg) || LONG_HEX.test(seg)) return ':id';
    return seg.length > 40 ? ':x' : seg;
  });
  let result = out.join('/') || '/';
  if (result.length > 1 && result.endsWith('/')) result = result.slice(0, -1);
  return result.length > MAX_LEN ? result.slice(0, MAX_LEN) : result;
}

/**
 * If the agent says the route did not match any handler (404 on an unknown path) we collapse the
 * name to "/unknown" for stats, so random scanning paths cannot blow up cardinality.
 */
function endpointFor({ path, route, routeMatched }) {
  if (routeMatched === false) return '/unknown';
  if (route && typeof route === 'string') return normalizePath(route);
  return normalizePath(path);
}

module.exports = { normalizePath, endpointFor };
