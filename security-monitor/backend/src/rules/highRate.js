'use strict';
const { hit } = require('../utils/counter');

function groupFor(path, cfg) {
  for (const g of cfg.groups) if (g.prefixes.some((p) => path === p || path.startsWith(`${p}/`) || path.startsWith(p))) return g;
  return { name: 'default', limit: cfg.defaultLimit };
}

module.exports = {
  name: 'HIGH_RATE',
  async evaluate(ev, ctx) {
    const cfg = ctx.detection.highRate;
    if (!cfg.enabled || ev.type !== 'access' || ev.kind !== 'normal') return [];
    const g = groupFor(ev.path.toLowerCase(), cfg);
    const count = await hit('rate', `${ev.ip}:${g.name}`, cfg.windowSec, ev.ts.getTime());
    if (count >= g.limit * cfg.blockMultiplier) {
      return [{ rule: 'HIGH_RATE', eventType: 'HIGH_REQUEST_RATE', severity: 'HIGH', title: 'Excessive request rate',
        description: `${count} requests to "${g.name}" endpoints from ${ev.ip} in ${cfg.windowSec}s (limit ${g.limit})`,
        cooldownKey: `rate-block:${ev.ip}:${g.name}`, block: { minutes: cfg.blockMinutes }, meta: { count, group: g.name, limit: g.limit } }];
    }
    if (count > g.limit) {
      return [{ rule: 'HIGH_RATE', eventType: 'HIGH_REQUEST_RATE', severity: 'MEDIUM', title: 'High request rate',
        description: `${count} requests to "${g.name}" endpoints from ${ev.ip} in ${cfg.windowSec}s (limit ${g.limit})`,
        cooldownKey: `rate-alert:${ev.ip}:${g.name}`, meta: { count, group: g.name, limit: g.limit } }];
    }
    return [];
  },
};
