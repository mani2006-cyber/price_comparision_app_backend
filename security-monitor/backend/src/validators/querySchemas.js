'use strict';
const { z } = require('zod');
const { normalizeIp } = require('../utils/ip');

const range = z.enum(['15m', '1h', '6h', '24h', '7d', '30d']).default('1h');
const RANGE_MS = { '15m': 9e5, '1h': 36e5, '6h': 216e5, '24h': 864e5, '7d': 6048e5, '30d': 2592e6 };
const sinceOf = (r) => new Date(Date.now() - RANGE_MS[r]);

const list = (v) => (v === undefined ? undefined : String(v).split(',').map((s) => s.trim()).filter(Boolean));
const csv = (allowed) => z.string().optional().transform(list).refine((a) => !a || a.every((x) => allowed.includes(x)), 'invalid value');
const paging = { page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) };
const SEV = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const date = z.string().datetime({ offset: true }).optional().transform((v) => (v ? new Date(v) : undefined));

const rangeQuery = z.object({ range });
const eventsQuery = z.object({
  from: date, to: date, severity: csv(SEV), eventType: z.string().max(400).optional().transform(list),
  ip: z.string().max(45).regex(/^[0-9a-fA-F:.]*$/).optional(), q: z.string().max(100).optional(), ...paging,
});
const alertsQuery = z.object({ status: z.enum(['OPEN', 'RESOLVED']).optional(), severity: csv(SEV), ...paging });
const blockedQuery = z.object({ status: z.enum(['active', 'all']).default('active'), ...paging });
const topIpsQuery = z.object({ range, metric: z.enum(['requests', 'failed_logins', 'suspicious']).default('requests'), limit: z.coerce.number().int().min(1).max(50).default(10) });
const endpointsQuery = z.object({ range, limit: z.coerce.number().int().min(1).max(50).default(10) });
const pagingQuery = z.object(paging);
const recentQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) });

const ipField = z.string().max(64).transform((v) => normalizeIp(v)).refine((v) => v !== null, 'invalid IP address');
const blockBody = z.object({ ip: ipField, minutes: z.number().int().min(1).max(1440).optional(), reason: z.string().trim().min(3).max(200) }).strict();
const loginBody = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(200) }).strict();

module.exports = { rangeQuery, eventsQuery, alertsQuery, blockedQuery, topIpsQuery, endpointsQuery, pagingQuery, recentQuery, blockBody, loginBody, sinceOf };
