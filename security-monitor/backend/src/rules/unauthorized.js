'use strict';
const { hit } = require('../utils/counter');

module.exports = {
  name: 'UNAUTHORIZED',
  async evaluate(ev, ctx) {
    const cfg = ctx.detection.unauthorized;
    if (!cfg.enabled || ev.type !== 'access' || ev.kind === 'preflight') return [];
    if (ev.status !== 401 && ev.status !== 403) return [];
    // Failed logins are handled by the brute-force rule; do not double count them.
    const lowered = ev.path.toLowerCase();
    if (ctx.detection.loginPaths.some((p) => lowered.startsWith(p.toLowerCase()))) return [];
    const c = await hit('unauth', ev.ip, cfg.windowSec, ev.ts.getTime());
    if (c >= cfg.blockThreshold) {
      return [{ rule: 'UNAUTHORIZED', eventType: 'UNAUTHORIZED_ACCESS', severity: 'HIGH', title: 'Repeated unauthorized access',
        description: `${c} unauthorized (401/403) responses for ${ev.ip} in ${Math.round(cfg.windowSec / 60)} min`,
        cooldownKey: `unauth-block:${ev.ip}`, block: { minutes: cfg.blockMinutes }, meta: { count: c } }];
    }
    if (c >= cfg.threshold) {
      return [{ rule: 'UNAUTHORIZED', eventType: 'UNAUTHORIZED_ACCESS', severity: 'MEDIUM', title: 'Repeated unauthorized access',
        description: `${c} unauthorized (401/403) responses for ${ev.ip} in ${Math.round(cfg.windowSec / 60)} min`,
        cooldownKey: `unauth-alert:${ev.ip}`, meta: { count: c } }];
    }
    return [];
  },
};
