'use strict';
const stats = require('../services/stats.service');
const eventsRepo = require('../repositories/events.repo');
const alertsRepo = require('../repositories/alerts.repo');
const accessRepo = require('../repositories/accessLogs.repo');
const auditRepo = require('../repositories/audit.repo');
const blocking = require('../services/blocking.service');
const settings = require('../services/settings.service');
const audit = require('../services/audit.service');
const broadcaster = require('../realtime/broadcaster');
const { AppError } = require('../utils/errors');
const { sinceOf } = require('../validators/querySchemas');

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// "24h"+ ranges beyond Redis buckets (7d/30d) fall back to the 24h buckets for live charts.
const bucketRange = (r) => (['7d', '30d'].includes(r) ? '24h' : r);

module.exports = {
  stats: wrap(async (req, res) => res.json(await stats.getStats(bucketRange(req.query.range)))),
  traffic: wrap(async (req, res) => res.json(await stats.getTraffic(bucketRange(req.query.range)))),
  recent: wrap(async (req, res) => res.json({ items: await stats.getRecent(req.query.limit) })),
  events: wrap(async (req, res) => res.json(await eventsRepo.search(req.query))),
  failedLogins: wrap(async (req, res) => res.json(await eventsRepo.search({ ...req.query, eventType: ['FAILED_LOGIN'] }))),
  topIps: wrap(async (req, res) => res.json({ items: await accessRepo.topIps({ since: sinceOf(req.query.range), metric: req.query.metric, limit: req.query.limit }) })),
  endpoints: wrap(async (req, res) => res.json({ items: await accessRepo.topEndpoints({ since: sinceOf(req.query.range), limit: req.query.limit }) })),
  alerts: wrap(async (req, res) => res.json(await alertsRepo.list(req.query))),

  resolveAlert: wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) throw new AppError(400, 'Invalid alert id', 'VALIDATION');
    const updated = await alertsRepo.resolve(id, req.admin.username);
    if (!updated) {
      const existing = await alertsRepo.findById(id);
      throw existing ? new AppError(409, 'Alert already resolved', 'ALREADY_RESOLVED') : new AppError(404, 'Alert not found', 'NOT_FOUND');
    }
    stats.invalidateOpenAlerts();
    broadcaster.emit('alert:resolved', updated);
    await audit.log(req.admin, 'ALERT_RESOLVED', { target: String(id), ip: req.ip });
    res.json(updated);
  }),

  blockedIps: wrap(async (req, res) => res.json(await blocking.list(req.query))),
  blockIp: wrap(async (req, res) => {
    const { ip, minutes, reason } = req.body;
    const result = await blocking.manualBlock({ ip, minutes, reason, admin: req.admin });
    await audit.log(req.admin, 'IP_BLOCKED', { target: ip, ip: req.ip, details: { minutes: result.minutes, reason } });
    res.status(201).json(result);
  }),
  unblockIp: wrap(async (req, res) => {
    const result = await blocking.unblock({ ip: decodeURIComponent(req.params.ip), admin: req.admin });
    await audit.log(req.admin, 'IP_UNBLOCKED', { target: result.ip, ip: req.ip });
    res.json(result);
  }),

  getSettings: wrap(async (req, res) => res.json(await settings.getAll())),
  updateSettings: wrap(async (req, res) => {
    const updated = await settings.update(req.body, req.admin.username);
    await audit.log(req.admin, 'SETTINGS_UPDATED', { ip: req.ip, details: { sections: Object.keys(req.body) } });
    res.json(updated);
  }),
  auditLogs: wrap(async (req, res) => res.json(await auditRepo.list(req.query))),
};
