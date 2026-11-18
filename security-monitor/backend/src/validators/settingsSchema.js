'use strict';
const net = require('net');
const { z } = require('zod');

const int = (min, max) => z.number().int().min(min).max(max);
const minutes = int(1, 1440);
const prefix = z.string().min(1).max(100).startsWith('/');
const allowEntry = z.string().min(2).max(50).refine((v) => {
  if (!v.includes('/')) return net.isIP(v) !== 0;
  const [base, bits] = v.split('/');
  return net.isIPv4(base) && /^\d{1,2}$/.test(bits) && Number(bits) <= 32;
}, 'must be an IP address or IPv4 CIDR');

const detection = z.object({
  loginPaths: z.array(prefix).max(20),
  alertCooldownSec: int(10, 86400),
  bruteForce: z.object({
    enabled: z.boolean(), ipWindowSec: int(10, 86400), ipAlertThreshold: int(1, 10000), ipBlockThreshold: int(1, 10000),
    accountWindowSec: int(10, 86400), accountAlertThreshold: int(1, 10000), blockMinutes: minutes,
  }).strict(),
  highRate: z.object({
    enabled: z.boolean(), windowSec: int(5, 3600), defaultLimit: int(1, 1000000), blockMultiplier: int(1, 100), blockMinutes: minutes,
    groups: z.array(z.object({
      name: z.string().regex(/^[a-z0-9_-]{1,30}$/), prefixes: z.array(prefix).min(1).max(10), limit: int(1, 1000000),
    }).strict()).max(30),
  }).strict(),
  endpointScan: z.object({
    enabled: z.boolean(), notFoundWindowSec: int(10, 86400), notFoundThreshold: int(1, 100000), notFoundBlockThreshold: int(1, 100000),
    sensitiveWindowSec: int(10, 86400), sensitiveThreshold: int(1, 100000), sensitiveBlockThreshold: int(1, 100000),
    blockMinutes: minutes, sensitivePaths: z.array(z.string().min(1).max(100)).max(200),
  }).strict(),
  suspiciousUrl: z.object({
    enabled: z.boolean(), windowSec: int(10, 86400), threshold: int(1, 100000), blockThreshold: int(1, 100000), blockMinutes: minutes,
  }).strict(),
  unauthorized: z.object({
    enabled: z.boolean(), windowSec: int(10, 86400), threshold: int(1, 100000), blockThreshold: int(1, 100000), blockMinutes: minutes,
  }).strict(),
}).strict();

const blocking = z.object({
  allowlist: z.array(allowEntry).max(200), defaultManualMinutes: minutes, maxMinutes: minutes,
}).strict();

const retention = z.object({
  accessLogsDays: int(1, 3650), securityEventsDays: int(1, 3650), alertsDays: int(1, 3650),
  auditDays: int(1, 3650), blockHistoryDays: int(1, 3650),
}).strict();

const updateSchema = z.object({
  detection: detection.optional(), blocking: blocking.optional(), retention: retention.optional(),
}).strict().refine((v) => Object.keys(v).length > 0, 'Send at least one section');

module.exports = { updateSchema };
