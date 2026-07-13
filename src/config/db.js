// src/config/db.js
//
// Owns the MongoDB connection lifecycle. Exposes connectDB() (call once,
// at startup) and disconnectDB() (call on graceful shutdown). Does NOT
// call process.exit() itself — see the comment above for why; server.js
// is responsible for deciding what a failed startup connection means for
// the process.

'use strict';

const mongoose = require('mongoose');
const config = require('./env');
const logger = require('../utils/logger');

let listenersAttached = false;

function attachConnectionListeners() {
    if (listenersAttached) {
        return; // avoid attaching duplicate listeners if connectDB() is ever called twice
    }
    listenersAttached = true;

    mongoose.connection.on('error', function(err) {
        logger.error('MongoDB connection error', err);
    });

    mongoose.connection.on('disconnected', function() {
        logger.warn('MongoDB disconnected');
    });

    mongoose.connection.on('reconnected', function() {
        logger.info('MongoDB reconnected');
    });
}

async function connectDB() {
    attachConnectionListeners();

    try {
        await mongoose.connect(config.mongoUri);
        logger.info('MongoDB connected', { database: mongoose.connection.name });
    } catch (err) {
        logger.error('MongoDB initial connection failed', err);
        // Re-throw rather than exiting here — the caller (server.js) decides
        // whether a failed startup connection should crash the process.
        throw err;
    }
}

async function disconnectDB() {
    if (mongoose.connection.readyState === 0) {
        return; // already disconnected, nothing to do
    }
    await mongoose.connection.close();
    logger.info('MongoDB connection closed');
}

module.exports = { connectDB, disconnectDB };