'use strict';
/** Turns a rule detection into: cooldown check -> optional temporary block -> security event -> alert. Severity is decided here only. */
const { redis } = require('../config/redis');
const K = require('../utils/redisKeys');
const blocking = require('./blocking.service');
const records = require('./records.service');
const stats = require('./stats.service');

async function handle(d, ev, ctx) {
  if (d.cooldownKey) {
    const first = await redis.set(K.cooldown(d.cooldownKey), '1', 'EX', ctx.detection.alertCooldownSec, 'NX');
    if (first !== 'OK') return null;
  }
  let action = d.alert === false ? 'LOGGED' : 'ALERT';
  let description = d.description;
  if (d.block) {
    const result = await blocking.autoBlock({ ip: ev.ip, minutes: d.block.minutes, reason: d.title, rule: d.rule });
    if (result.blocked) action = 'BLOCKED';
    else if (result.reason === 'allowlisted') description += ' (IP is allowlisted, so it was not blocked)';
  }
  const event = await records.recordEvent({ ip: ev.ip, eventType: d.eventType, severity: d.severity,
    endpoint: d.endpoint || ev.endpoint || null, description, action, createdAt: ev.ts, meta: { rule: d.rule, ...(d.meta || {}) } });
  if (d.alert !== false) {
    await records.recordAlert({ ip: ev.ip, rule: d.rule, severity: d.severity, title: d.title, message: description,
      createdAt: ev.ts, eventId: event.id, meta: { rule: d.rule, ...(d.meta || {}) } });
    stats.invalidateOpenAlerts();
  }
  return event;
}

module.exports = { handle };
