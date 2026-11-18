'use strict';
const auditRepo = require('../repositories/audit.repo');
const logger = require('../utils/logger');

/** Never throws: an audit failure must not break the action itself. */
async function log(admin, action, { target = null, ip = null, details = null } = {}) {
  try {
    await auditRepo.insert({ adminId: admin ? admin.id : null, adminUsername: admin ? admin.username : null, action, target, ip, details });
  } catch (err) {
    logger.error({ err: err.message, action }, 'audit log write failed');
  }
}
module.exports = { log };
