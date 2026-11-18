'use strict';
const router = require('express').Router();
const c = require('../controllers/security.controller');
const { authAdmin, requireRole, requireCsrfHeader } = require('../middleware/authAdmin');
const { validate } = require('../middleware/validate');
const { updateSchema } = require('../validators/settingsSchema');
const q = require('../validators/querySchemas');

router.use(authAdmin, requireCsrfHeader);

// Read: any signed-in admin (viewer+)
router.get('/stats', validate(q.rangeQuery, 'query'), c.stats);
router.get('/traffic', validate(q.rangeQuery, 'query'), c.traffic);
router.get('/recent-traffic', validate(q.recentQuery, 'query'), c.recent);
router.get('/events', validate(q.eventsQuery, 'query'), c.events);
router.get('/failed-logins', validate(q.eventsQuery, 'query'), c.failedLogins);
router.get('/top-ips', validate(q.topIpsQuery, 'query'), c.topIps);
router.get('/endpoints', validate(q.endpointsQuery, 'query'), c.endpoints);
router.get('/alerts', validate(q.alertsQuery, 'query'), c.alerts);
router.get('/blocked-ips', validate(q.blockedQuery, 'query'), c.blockedIps);

// Analyst+: triage alerts
router.post('/alerts/:id/resolve', requireRole('analyst'), c.resolveAlert);

// Admin only: change enforcement and configuration
router.post('/blocked-ips', requireRole('admin'), validate(q.blockBody), c.blockIp);
router.delete('/blocked-ips/:ip', requireRole('admin'), c.unblockIp);
router.get('/settings', requireRole('admin'), c.getSettings);
router.put('/settings', requireRole('admin'), validate(updateSchema), c.updateSettings);
router.get('/audit-logs', requireRole('admin'), validate(q.pagingQuery, 'query'), c.auditLogs);

module.exports = router;
