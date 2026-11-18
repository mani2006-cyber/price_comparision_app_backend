'use strict';
const router = require('express').Router();
const c = require('../controllers/auth.controller');
const { validate } = require('../middleware/validate');
const { loginLimiter } = require('../middleware/rateLimit');
const { authAdmin, requireCsrfHeader } = require('../middleware/authAdmin');
const { loginBody } = require('../validators/querySchemas');

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
router.post('/login', loginLimiter, requireCsrfHeader, validate(loginBody), wrap(c.login));
router.post('/logout', authAdmin, requireCsrfHeader, wrap(c.logout));
router.get('/me', authAdmin, c.me);
module.exports = router;
