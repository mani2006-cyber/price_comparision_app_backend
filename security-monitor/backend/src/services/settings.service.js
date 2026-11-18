'use strict';
/** Effective settings = defaults + admin overrides from MySQL, cached 10s so rules never query MySQL per event. */
const defaults = require('./settings.defaults');
const repo = require('../repositories/settings.repo');
const logger = require('../utils/logger');

const TTL_MS = 10000;
let cache = { at: 0, value: null };
const isPlain = (v) => v && typeof v === 'object' && !Array.isArray(v);

function deepMerge(base, over) {
  if (!isPlain(base) || !isPlain(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = deepMerge(base[k], over[k]);
  return out;
}

async function getAll() {
  if (cache.value && Date.now() - cache.at < TTL_MS) return cache.value;
  try {
    const stored = await repo.getAll();
    const merged = {
      detection: deepMerge(defaults.detection, stored.detection || {}),
      blocking: deepMerge(defaults.blocking, stored.blocking || {}),
      retention: deepMerge(defaults.retention, stored.retention || {}),
    };
    cache = { at: Date.now(), value: merged };
    return merged;
  } catch (err) {
    logger.error({ err: err.message }, 'settings load failed');
    return cache.value || JSON.parse(JSON.stringify(defaults));
  }
}

const getDetection = async () => (await getAll()).detection;
const getBlocking = async () => (await getAll()).blocking;
const getRetention = async () => (await getAll()).retention;

async function update(sections, adminName) {
  for (const [key, value] of Object.entries(sections)) {
    if (key === 'detection') {
      value.endpointScan.sensitivePaths = value.endpointScan.sensitivePaths.map((s) => s.toLowerCase());
    }
    await repo.upsert(key, value, adminName);
  }
  cache = { at: 0, value: null };
  return getAll();
}

module.exports = { getAll, getDetection, getBlocking, getRetention, update, deepMerge };
