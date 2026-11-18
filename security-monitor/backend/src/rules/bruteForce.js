'use strict';
const { hit } = require('../utils/counter');

module.exports = {
  name: 'BRUTE_FORCE',
  async evaluate(ev, ctx) {
    const cfg = ctx.detection.bruteForce;
    if (!cfg.enabled || ev.type !== 'auth' || ev.outcome !== 'failure') return [];
    const out = [{ rule: 'BRUTE_FORCE', eventType: 'FAILED_LOGIN', severity: 'LOW', alert: false,
      title: 'Failed login', description: `Failed login attempt from ${ev.ip}`, endpoint: ev.path ? ev.path.split('?')[0] : null }];

    const ipCount = await hit('bf-ip', ev.ip, cfg.ipWindowSec, ev.ts.getTime());
    if (ipCount >= cfg.ipBlockThreshold) {
      out.push({ rule: 'BRUTE_FORCE', eventType: 'BRUTE_FORCE', severity: 'HIGH', title: 'Brute-force login attack',
        description: `${ipCount} failed logins from ${ev.ip} within ${Math.round(cfg.ipWindowSec / 60)} min`,
        cooldownKey: `bf-block:${ev.ip}`, block: { minutes: cfg.blockMinutes }, meta: { count: ipCount } });
    } else if (ipCount >= cfg.ipAlertThreshold) {
      out.push({ rule: 'BRUTE_FORCE', eventType: 'BRUTE_FORCE', severity: 'MEDIUM', title: 'Multiple failed logins',
        description: `${ipCount} failed logins from ${ev.ip} within ${Math.round(cfg.ipWindowSec / 60)} min`,
        cooldownKey: `bf-alert:${ev.ip}`, meta: { count: ipCount } });
    }
    if (ev.accountHash) {
      const accCount = await hit('bf-acct', ev.accountHash, cfg.accountWindowSec, ev.ts.getTime());
      if (accCount >= cfg.accountAlertThreshold) {
        // Alert only: never block/lock by account (that would let attackers lock real users out).
        out.push({ rule: 'BRUTE_FORCE', eventType: 'ACCOUNT_ATTACK', severity: 'MEDIUM', title: 'Targeted account attack',
          description: `${accCount} failed logins against one account (id ${ev.accountHash.slice(0, 8)}) from one or more IPs`,
          cooldownKey: `bf-acct:${ev.accountHash}`, meta: { count: accCount, accountRef: ev.accountHash.slice(0, 8) } });
      }
    }
    return out;
  },
};
