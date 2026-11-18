'use strict';
/** Runs every enabled rule for one event. Returns { suspicious } (true if a real alert-level detection happened). */
const rules = require('../rules');
const detectionService = require('./detection.service');
const logger = require('../utils/logger');

async function run(ev, ctx) {
  let suspicious = false;
  for (const rule of rules) {
    let detections = [];
    try {
      detections = await rule.evaluate(ev, ctx);
    } catch (err) {
      // Redis/MySQL failures must bubble up so the batch is retried, never silently lost.
      throw err;
    }
    for (const d of detections) {
      try {
        const stored = await detectionService.handle(d, ev, ctx);
        if (stored && d.alert !== false) suspicious = true;
      } catch (err) {
        logger.error({ err: err.message, rule: rule.name }, 'detection handling failed');
        throw err;
      }
    }
  }
  return { suspicious };
}

module.exports = { run };
