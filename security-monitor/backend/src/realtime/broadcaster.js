'use strict';
/** Pushes real-time updates to authenticated dashboards. Traffic rows and stats are batched, never per-event. */
const logger = require('../utils/logger');

let io = null;
const trafficQueue = [];
const timers = [];

const setIo = (server) => { io = server; };
const hasClients = () => !!io && io.engine.clientsCount > 0;
const emit = (event, payload) => { if (io) io.to('admins').emit(event, payload); };

function queueTraffic(item) {
  if (!hasClients()) return;
  trafficQueue.push(item);
  if (trafficQueue.length > 500) trafficQueue.splice(0, trafficQueue.length - 500);
}

function start(getSnapshot) {
  stop();
  timers.push(setInterval(() => {
    if (!hasClients()) { trafficQueue.length = 0; return; }
    const batch = trafficQueue.splice(0, 100);
    if (batch.length) emit('traffic:batch', batch);
  }, 1000));
  timers.push(setInterval(async () => {
    if (!hasClients()) return;
    try { emit('stats:tick', await getSnapshot()); } catch (err) { logger.debug({ err: err.message }, 'stats tick skipped'); }
  }, 2000));
  timers.forEach((t) => t.unref());
}
function stop() { while (timers.length) clearInterval(timers.pop()); }

module.exports = { setIo, emit, queueTraffic, start, stop };
