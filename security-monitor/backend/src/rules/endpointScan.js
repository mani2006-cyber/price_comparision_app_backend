'use strict';
const { hit } = require('../utils/counter');

module.exports = {
  name: 'ENDPOINT_SCAN',
  async evaluate(ev, ctx) {
    const cfg = ctx.detection.endpointScan;
    if (!cfg.enabled || ev.type !== 'access' || ev.kind === 'preflight') return [];
    const out = [];
    const lowered = ev.path.toLowerCase();

    if (cfg.sensitivePaths.some((s) => lowered.includes(s))) {
      const c = await hit('scan-sens', ev.ip, cfg.sensitiveWindowSec, ev.ts.getTime());
      if (c >= cfg.sensitiveBlockThreshold) {
        out.push({ rule: 'ENDPOINT_SCAN', eventType: 'ENDPOINT_SCAN', severity: 'HIGH', title: 'Sensitive path probing',
          description: `${c} requests to sensitive paths (e.g. /.env, /.git) from ${ev.ip}`,
          cooldownKey: `scan-sens-block:${ev.ip}`, block: { minutes: cfg.blockMinutes }, meta: { count: c } });
      } else if (c >= cfg.sensitiveThreshold) {
        out.push({ rule: 'ENDPOINT_SCAN', eventType: 'ENDPOINT_SCAN', severity: 'MEDIUM', title: 'Sensitive path probing',
          description: `${c} requests to sensitive paths (e.g. /.env, /.git) from ${ev.ip}`,
          cooldownKey: `scan-sens-alert:${ev.ip}`, meta: { count: c } });
      }
    }
    if (ev.status === 404) {
      // 404 on a route that does not exist counts fully; 404 on a real route (e.g. deleting an already-deleted item) is ignored.
      if (ev.routeMatched === false || ev.endpoint === '/unknown') {
        const c = await hit('scan-404', ev.ip, cfg.notFoundWindowSec, ev.ts.getTime());
        if (c >= cfg.notFoundBlockThreshold) {
          out.push({ rule: 'ENDPOINT_SCAN', eventType: 'ENDPOINT_SCAN', severity: 'HIGH', title: 'Endpoint scanning',
            description: `${c} requests to unknown endpoints from ${ev.ip} in ${Math.round(cfg.notFoundWindowSec / 60)} min`,
            cooldownKey: `scan-404-block:${ev.ip}`, block: { minutes: cfg.blockMinutes }, meta: { count: c } });
        } else if (c >= cfg.notFoundThreshold) {
          out.push({ rule: 'ENDPOINT_SCAN', eventType: 'ENDPOINT_SCAN', severity: 'MEDIUM', title: 'Endpoint scanning',
            description: `${c} requests to unknown endpoints from ${ev.ip} in ${Math.round(cfg.notFoundWindowSec / 60)} min`,
            cooldownKey: `scan-404-alert:${ev.ip}`, meta: { count: c } });
        }
      }
    }
    return out;
  },
};
