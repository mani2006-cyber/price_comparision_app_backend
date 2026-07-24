// server.js
//
// Real entry point - npm start runs this file. Owns the process
// lifecycle: startup ordering (DB before HTTP), what a failed startup
// means (exit non-zero), and graceful shutdown (drain connections,
// close the DB, THEN exit). app.js itself has no knowledge of any of
// this - it's purely the Express app definition, importable/testable
// without ever calling .listen().

'use strict';

const config = require('./src/config/env');
const logger = require('./src/utils/logger');
const { connectDB, disconnectDB } = require('./src/config/db');
const app = require('./src/app');
const priceRefresherJob = require("./src/jobs/priceRefresher.Job")
const { disconnectRedis } = require('./src/config/redis');

const SHUTDOWN_TIMEOUT_MS = 10000;

let server;

async function start() {
    try {
        await connectDB();
    } catch (err) {
        // connectDB() deliberately does NOT call process.exit() itself (see
        // File 5's header comment) - this is where that decision belongs.
        // An app that "starts" but can't reach its database would accept
        // requests and fail every one of them - worse than not starting.
        logger.error('Failed to start: could not connect to MongoDB', err);
        process.exit(1);
    }

    server = app.listen(config.port, function() {
        logger.info('Server started', { port: config.port, env: config.env });

        // Started after the HTTP server is up, not before - the refresher
        // has nothing to do with request-serving readiness, and this keeps
        // the startup log order honest: DB connected -> server listening ->
        // background job scheduled.
        priceRefresherJob.start();
    });
}

// ── Graceful shutdown ────────────────────────────────────────────────
function shutdown(signal) {
    logger.info('Received shutdown signal, closing gracefully', { signal });

    const forceExitTimer = setTimeout(function() {
        logger.error('Graceful shutdown timed out, forcing exit');
        process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);

    if (!server) {
        clearTimeout(forceExitTimer);
        process.exit(0);
        return;
    }

    server.close(async function() {
        // No new connections accepted from this point on; in-flight
        // requests have already finished by the time this callback fires.
        try {
            await disconnectDB();
            await disconnectRedis();
            clearTimeout(forceExitTimer);
            logger.info('Shutdown complete');
            process.exit(0);
        } catch (err) {
            logger.error('Error during shutdown', err);
            clearTimeout(forceExitTimer);
            process.exit(1);
        }
    });
}

process.on('SIGINT', function() { shutdown('SIGINT'); }); // Ctrl+C locally
process.on('SIGTERM', function() { shutdown('SIGTERM'); }); // container/platform stop signal

// ── Last line of defense for errors outside Express's request lifecycle
// - NOT a substitute for asyncHandler/errorHandler, which correctly
// handle the vast majority of errors already ──────────────────────────
process.on('unhandledRejection', function(reason) {
    logger.error('Unhandled promise rejection', reason instanceof Error ? reason : new Error(String(reason)));
    process.exit(1);
});

process.on('uncaughtException', function(err) {
    logger.error('Uncaught exception', err);
    process.exit(1);
});

start();