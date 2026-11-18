'use strict';
const ingestion = require('../services/ingestion.service');
const blocking = require('../services/blocking.service');
const { batchSchema } = require('../validators/eventSchema');
const { AppError } = require('../utils/errors');
const logger = require('../utils/logger');

async function events(req, res, next) {
  try {
    const parsed = batchSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, 'Invalid batch', 'VALIDATION');
    if (parsed.data.dropped) logger.warn({ dropped: parsed.data.dropped }, 'agent reported dropped events (spool overflow)');
    // Responds only after everything is persisted, so a 2xx means the agent may delete its spool copy.
    const result = await ingestion.ingest(parsed.data.events);
    res.json(result);
  } catch (err) { next(err); }
}

async function blocklist(req, res, next) {
  try { res.json({ generatedAt: Date.now(), items: await blocking.getBlocklist() }); } catch (err) { next(err); }
}

module.exports = { events, blocklist };
