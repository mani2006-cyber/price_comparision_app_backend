'use strict';
/**
 * Temporary IP blocking: Redis key with TTL (self-expiring) + Redis zset (list for the agent) + MySQL history (audit trail).
 * No permanent automatic blocks: every block has a TTL capped by blocking.maxMinutes.
 */
const { redis } = require('../config/redis');
const K = require('../utils/redisKeys');
const { normalizeIp, isAllowlisted } = require('../utils/ip');
const { AppError } = require('../utils/errors');
const settingsService = require('./settings.service');
const blockedRepo = require('../repositories/blocked.repo');
const records = require('./records.service');
const broadcaster = require('../realtime/broadcaster');
const stats = require('./stats.service');
const logger = require('../utils/logger');

async function block({ ip, minutes, reason, rule = null, source, admin = null }) {
  const nip = normalizeIp(ip);
  if (!nip) throw new AppError(400, 'Invalid IP address', 'INVALID_IP');
  const cfg = await settingsService.getBlocking();
  const mins = Math.max(1, Math.min(Math.floor(minutes || cfg.defaultManualMinutes), cfg.maxMinutes));

  if (isAllowlisted(nip, cfg.allowlist)) {
    if (source === 'MANUAL') throw new AppError(409, 'This IP is on the allowlist and cannot be blocked', 'IP_ALLOWLISTED');
    return { blocked: false, reason: 'allowlisted' };
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + mins * 60000);
  const payload = JSON.stringify({ reason, rule, source, expiresAt: expiresAt.toISOString() });

  // Atomic claim (NX): only one concurrent caller can create the block.
  const claimed = await redis.set(K.block(nip), payload, 'EX', mins * 60, 'NX');
  if (claimed !== 'OK') {
    if (source === 'MANUAL') throw new AppError(409, 'This IP is already blocked', 'ALREADY_BLOCKED');
    return { blocked: false, reason: 'already_blocked' };
  }

  let historyId;
  try {
    historyId = await blockedRepo.insert({ ip: nip, reason, rule, source, blockedBy: admin ? admin.username : null,
      detectedAt: now, durationSeconds: mins * 60, expiresAt });
    await redis.zadd(K.blockedZset, expiresAt.getTime(), nip);
  } catch (err) {
    await redis.del(K.block(nip)).catch(() => {});
    await redis.zrem(K.blockedZset, nip).catch(() => {});
    if (historyId) await blockedRepo.revert(historyId).catch(() => {});
    throw err;
  }

  const who = source === 'MANUAL' ? `manually by ${admin ? admin.username : 'admin'}` : 'automatically';
  const event = await records.recordEvent({ ip: nip, eventType: 'IP_BLOCKED', severity: 'HIGH', createdAt: now, action: 'BLOCKED',
    description: `IP blocked for ${mins} min ${who}: ${reason}`, meta: { rule, source, minutes: mins } });
  await records.recordAlert({ ip: nip, rule: 'IP_BLOCKED', severity: 'HIGH', title: 'IP address blocked', createdAt: now, eventId: event.id,
    message: `${nip} was blocked for ${mins} minutes ${who}. Reason: ${reason}`, meta: { rule, source, minutes: mins } });
  stats.invalidateOpenAlerts();
  broadcaster.emit('block:changed', { ip: nip, status: 'ACTIVE' });
  logger.info({ ip: nip, minutes: mins, source, rule }, 'IP blocked');
  return { blocked: true, ip: nip, minutes: mins, expiresAt: expiresAt.toISOString(), historyId };
}

const autoBlock = (args) => block({ ...args, source: 'AUTO' });
const manualBlock = (args) => block({ ...args, source: 'MANUAL' });

async function unblock({ ip, admin }) {
  const nip = normalizeIp(ip);
  if (!nip) throw new AppError(400, 'Invalid IP address', 'INVALID_IP');
  const deleted = await redis.del(K.block(nip));
  await redis.zrem(K.blockedZset, nip);
  const changed = await blockedRepo.markUnblocked(nip, admin ? admin.username : null);
  if (!deleted && !changed) throw new AppError(404, 'This IP is not currently blocked', 'NOT_BLOCKED');
  await records.recordEvent({ ip: nip, eventType: 'IP_UNBLOCKED', severity: 'LOW', action: 'UNBLOCKED',
    description: `IP unblocked by ${admin ? admin.username : 'admin'}`, meta: { by: admin ? admin.username : null } });
  broadcaster.emit('block:changed', { ip: nip, status: 'UNBLOCKED' });
  return { ip: nip };
}

async function sweepExpired() {
  const ips = await blockedRepo.expireDue(new Date());
  await redis.zremrangebyscore(K.blockedZset, '-inf', Date.now());
  for (const ip of ips) broadcaster.emit('block:changed', { ip, status: 'EXPIRED' });
  return ips.length;
}

async function getBlocklist() {
  const flat = await redis.zrangebyscore(K.blockedZset, Date.now(), '+inf', 'WITHSCORES');
  const list = [];
  for (let i = 0; i < flat.length; i += 2) list.push({ ip: flat[i], expiresAt: Number(flat[i + 1]) });
  return list;
}

const list = (opts) => blockedRepo.list(opts);

module.exports = { autoBlock, manualBlock, unblock, sweepExpired, getBlocklist, list };
