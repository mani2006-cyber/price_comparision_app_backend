'use strict';
const { Server } = require('socket.io');
const cookie = require('cookie');
const config = require('../config/env');
const { verifyToken, COOKIE } = require('../middleware/authAdmin');
const adminsRepo = require('../repositories/admins.repo');
const broadcaster = require('./broadcaster');
const logger = require('../utils/logger');

function createSocketServer(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: config.frontendOrigins, credentials: true },
    maxHttpBufferSize: 1e4,
    allowRequest: (req, cb) => {
      const origin = req.headers.origin;   // exact-origin check (blocks cross-site websocket hijacking)
      cb(null, !origin || config.frontendOrigins.includes(origin));
    },
  });

  io.use(async (socket, next) => {
    try {
      const token = cookie.parse(socket.request.headers.cookie || '')[COOKIE];
      if (!token) return next(new Error('unauthenticated'));
      const payload = verifyToken(token);
      const admin = await adminsRepo.findById(payload.sub);
      if (!admin || !admin.is_active) return next(new Error('unauthenticated'));
      socket.data.admin = { id: admin.id, username: admin.username, role: admin.role };
      return next();
    } catch { return next(new Error('unauthenticated')); }
  });

  io.on('connection', (socket) => {
    socket.join('admins');
    logger.debug({ admin: socket.data.admin.username }, 'socket connected');
  });

  broadcaster.setIo(io);
  return io;
}

module.exports = { createSocketServer };
