'use strict';
const express = require('express');
const router = express.Router();
const c = require('../controllers/internal.controller');
const { verifyServiceSignature } = require('../middleware/verifyServiceSignature');
const { ingestLimiter } = require('../middleware/rateLimit');

// Raw body is required so the HMAC covers the exact bytes the agent sent. 512 KB cap per batch.
router.use(ingestLimiter, express.raw({ type: '*/*', limit: '512kb' }), verifyServiceSignature);
router.post('/events', c.events);
router.get('/blocklist', c.blocklist);
module.exports = router;
