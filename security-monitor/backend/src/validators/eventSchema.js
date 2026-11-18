'use strict';
/** Every event from the agent is validated. Unknown fields are dropped, so a client can never set severity or event type outside this list. */
const { z } = require('zod');
const { normalizeIp } = require('../utils/ip');

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];
const ip = z.string().max(64).transform((v) => normalizeIp(v)).refine((v) => v !== null, { message: 'invalid ip' });
const base = { eventId: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/), ts: z.string().max(40).optional(), ip };

const access = z.object({
  type: z.literal('access'), ...base,
  method: z.string().max(10).transform((s) => s.toUpperCase()).refine((m) => METHODS.includes(m), { message: 'bad method' }),
  path: z.string().min(1).max(2048),
  route: z.string().max(200).optional(),
  routeMatched: z.boolean().optional(),
  status: z.number().int().min(100).max(599),
  durationMs: z.number().min(0).max(1e10),
  userAgent: z.string().max(500).optional(),
  streaming: z.boolean().optional(),
  blocked: z.boolean().optional(),
});
const auth = z.object({
  type: z.literal('auth'), ...base,
  outcome: z.enum(['failure', 'success']),
  accountHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  path: z.string().max(2048).optional(),
});
const urlRejected = z.object({
  type: z.literal('url_rejected'), ...base,
  reason: z.enum(['unsupported_marketplace', 'invalid_url', 'ssrf_blocked']),
  host: z.string().max(253).optional(),
  path: z.string().max(2048).optional(),
});

const eventSchema = z.discriminatedUnion('type', [access, auth, urlRejected]);
const batchSchema = z.object({ events: z.array(z.unknown()).min(1).max(200), dropped: z.number().int().min(0).optional() });

module.exports = { eventSchema, batchSchema };
