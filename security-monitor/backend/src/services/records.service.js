'use strict';
const eventsRepo = require('../repositories/events.repo');
const alertsRepo = require('../repositories/alerts.repo');
const broadcaster = require('../realtime/broadcaster');

async function recordEvent(e) {
  const row = await eventsRepo.insert(e);
  broadcaster.emit('event:new', row);
  return row;
}
async function recordAlert(a) {
  const row = await alertsRepo.insert(a);
  broadcaster.emit('alert:new', row);
  return row;
}
module.exports = { recordEvent, recordAlert };
