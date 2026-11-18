'use strict';
const jwt = require('jsonwebtoken');
const config = require('../config/env');
const adminsRepo = require('../repositories/admins.repo');
const { AppError } = require('../utils/errors');

const COOKIE = 'sm_token';
const ROLE_RANK = { viewer: 1, analyst: 2, admin: 3 };

const cookieOptions = () => ({ httpOnly: true, sameSite: 'strict', secure: config.cookieSecure, path: '/', maxAge: config.jwtTtlMin * 60 * 1000 });
const signToken = (admin) => jwt.sign({ sub: admin.id, role: admin.role, u: admin.username }, config.jwtSecret,
  { algorithm: 'HS256', expiresIn: `${config.jwtTtlMin}m` });
const verifyToken = (t) => jwt.verify(t, config.jwtSecret, { algorithms: ['HS256'] });

/** Verifies the cookie, re-checks the admin in MySQL (so deactivation/role change is immediate) and slides the session. */
async function authAdmin(req, res, next) {
  try {
    const token = req.cookies && req.cookies[COOKIE];
    if (!token) throw new AppError(401, 'Authentication required', 'UNAUTHENTICATED');
    let payload;
    try { payload = verifyToken(token); } catch { throw new AppError(401, 'Session expired', 'UNAUTHENTICATED'); }
    const admin = await adminsRepo.findById(payload.sub);
    if (!admin || !admin.is_active) throw new AppError(401, 'Account disabled', 'UNAUTHENTICATED');
    req.admin = { id: admin.id, username: admin.username, role: admin.role };
    if (payload.exp * 1000 - Date.now() < (config.jwtTtlMin * 60 * 1000) / 2) res.cookie(COOKIE, signToken(req.admin), cookieOptions());
    next();
  } catch (err) { next(err); }
}

/** requireRole('analyst') = analyst or higher. */
const requireRole = (min) => (req, res, next) => {
  if (!req.admin || ROLE_RANK[req.admin.role] < ROLE_RANK[min]) return next(new AppError(403, 'Insufficient permissions', 'FORBIDDEN'));
  return next();
};

/**
 * CSRF defence for state-changing requests: SameSite=Strict cookie AND a custom header that browsers only allow
 * after a CORS preflight (which only our exact frontend origin passes).
 */
function requireCsrfHeader(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-requested-with') !== 'SecurityMonitor') return next(new AppError(403, 'Missing CSRF header', 'CSRF'));
  return next();
}

module.exports = { authAdmin, requireRole, requireCsrfHeader, signToken, verifyToken, cookieOptions, COOKIE, ROLE_RANK };
