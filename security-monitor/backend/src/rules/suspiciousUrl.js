'use strict';
const { hit } = require('../utils/counter');

const LABELS = { ssrf_blocked: 'blocked internal/SSRF URL', invalid_url: 'invalid URL', unsupported_marketplace: 'unsupported marketplace URL' };

module.exports = {
  name: 'SUSPICIOUS_URL',
  async evaluate(ev, ctx) {
    const cfg = ctx.detection.suspiciousUrl;
    if (!cfg.enabled || ev.type !== 'url_rejected') return [];
    const weight = ev.reason === 'ssrf_blocked' ? 3 : 1; // SSRF attempts are far more serious than typos
    let c = 0;
    for (let i = 0; i < weight; i++) c = await hit('badurl', ev.ip, cfg.windowSec, ev.ts.getTime());
    const label = LABELS[ev.reason] || 'rejected URL';
    const out = [{ rule: 'SUSPICIOUS_URL', eventType: 'SUSPICIOUS_URL', severity: ev.reason === 'ssrf_blocked' ? 'MEDIUM' : 'LOW', alert: false,
      title: 'Rejected URL submission', description: `${label} submitted from ${ev.ip}${ev.host ? ` (host ${ev.host})` : ''}`,
      endpoint: '/api/compare-url', meta: { reason: ev.reason, host: ev.host || null } }];
    if (c >= cfg.blockThreshold) {
      out.push({ rule: 'SUSPICIOUS_URL', eventType: 'SUSPICIOUS_URL', severity: 'HIGH', title: 'Repeated suspicious URL submissions',
        description: `Score ${c} of rejected/internal URL submissions from ${ev.ip}`, endpoint: '/api/compare-url',
        cooldownKey: `url-block:${ev.ip}`, block: { minutes: cfg.blockMinutes }, meta: { score: c } });
    } else if (c >= cfg.threshold) {
      out.push({ rule: 'SUSPICIOUS_URL', eventType: 'SUSPICIOUS_URL', severity: 'MEDIUM', title: 'Repeated suspicious URL submissions',
        description: `Score ${c} of rejected/internal URL submissions from ${ev.ip}`, endpoint: '/api/compare-url',
        cooldownKey: `url-alert:${ev.ip}`, meta: { score: c } });
    }
    return out;
  },
};
