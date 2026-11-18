'use strict';
const bcrypt = require('bcryptjs');
const adminsRepo = require('../repositories/admins.repo');
const audit = require('../services/audit.service');
const { AppError } = require('../utils/errors');
const { signToken, cookieOptions, COOKIE } = require('../middleware/authAdmin');

const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
// Compared when the user does not exist, so response time does not reveal valid usernames.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

async function login(req, res) {
  const { username, password } = req.body;
  const admin = await adminsRepo.findByUsername(username);
  const fail = async (reason) => {
    await audit.log(admin ? { id: admin.id, username } : { id: null, username }, 'LOGIN_FAILED', { target: username, ip: req.ip, details: { reason } });
    throw new AppError(401, 'Invalid username or password', 'INVALID_CREDENTIALS');
  };

  if (admin && admin.locked_until && new Date(admin.locked_until) > new Date()) {
    await audit.log({ id: admin.id, username }, 'LOGIN_BLOCKED', { ip: req.ip, details: { reason: 'locked' } });
    throw new AppError(429, 'Account temporarily locked. Try again later.', 'LOCKED');
  }
  const ok = await bcrypt.compare(password, admin ? admin.password_hash : DUMMY_HASH);
  if (!admin || !admin.is_active || !ok) {
    if (admin) {
      const fails = admin.failed_attempts + 1;
      await adminsRepo.recordLoginFailure(admin.id, fails >= MAX_FAILS ? 0 : fails, fails >= MAX_FAILS ? new Date(Date.now() + LOCK_MS) : null);
    }
    return fail(!admin ? 'unknown_user' : !admin.is_active ? 'inactive' : 'bad_password');
  }
  await adminsRepo.recordLoginSuccess(admin.id);
  const user = { id: admin.id, username: admin.username, role: admin.role };
  res.cookie(COOKIE, signToken(user), cookieOptions());
  await audit.log(user, 'LOGIN', { ip: req.ip });
  res.json({ user });
}

async function logout(req, res) {
  await audit.log(req.admin, 'LOGOUT', { ip: req.ip });
  res.clearCookie(COOKIE, { ...cookieOptions(), maxAge: undefined });
  res.json({ ok: true });
}

const me = (req, res) => res.json({ user: req.admin });

module.exports = { login, logout, me };
