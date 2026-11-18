'use strict';
const pino = require('pino');
const config = require('../config/env');
module.exports = pino({ level: config.logLevel, redact: ['req.headers.authorization', 'req.headers.cookie'] });
