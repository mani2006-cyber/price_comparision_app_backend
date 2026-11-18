'use strict';
const settingsService = require('./settings.service');
const accessRepo = require('../repositories/accessLogs.repo');
const eventsRepo = require('../repositories/events.repo');
const alertsRepo = require('../repositories/alerts.repo');
const auditRepo = require('../repositories/audit.repo');
const blockedRepo = require('../repositories/blocked.repo');
const logger = require('../utils/logger');

async function purge(fn, days) {
  const cutoff = new Date(Date.now() - days * 86400000);
  let total = 0; let n;
  do { n = await fn(cutoff, 5000); total += n; } while (n === 5000);
  return total;
}

async function run() {
  const r = await settingsService.getRetention();
  const out = {
    accessLogs: await purge(accessRepo.deleteOlderThan, r.accessLogsDays),
    events: await purge(eventsRepo.deleteOlderThan, r.securityEventsDays),
    alerts: await purge(alertsRepo.deleteOlderThan, r.alertsDays),
    audit: await purge(auditRepo.deleteOlderThan, r.auditDays),
    blockHistory: await purge(blockedRepo.deleteOlderThan, r.blockHistoryDays),
  };
  logger.info(out, 'retention cleanup done');
  return out;
}

module.exports = { run };
