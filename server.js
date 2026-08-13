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
const priceRefresherJob = require('./src/jobs/priceRefresher.job');
const priceRefresherQueue = require('./src/queues/priceRefresher.queue');
const notificationBus = require('./src/realtime/notificationBus');
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
        return; // explicit, not just relying on process.exit()'s real-process termination - keeps this function correct even where exit is mocked/intercepted (e.g. under test)
    }

    server = app.listen(config.port, function() {
        logger.info('Server started', { port: config.port, env: config.env });

        // Started after the HTTP server is up, not before - the refresher
        // has nothing to do with request-serving readiness, and this keeps
        // the startup log order honest: DB connected -> server listening ->
        // background job scheduled.
        //
        // BullMQ needs Redis (no in-memory fallback); when Redis is
        // disabled/unavailable (config.redis.enabled=false - e.g. a
        // minimal local setup), fall back to the plain node-cron
        // scheduler instead, so this job still runs somehow either way -
        // the same "caching is optional infrastructure" posture
        // src/config/redis.js already applies to this app.
        if (config.redis.enabled) {
            priceRefresherQueue.start().catch(function(err) {
                logger.error('Failed to start price refresher queue, falling back to node-cron', err);
                priceRefresherJob.start();
            });
        } else {
            priceRefresherJob.start();
        }
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
            if (config.redis.enabled) {
                // Lets the Worker finish whatever job it's mid-run on
                // (bounded by its own internal grace period) instead of
                // yanking the Redis connection out from under it.
                await priceRefresherQueue.close();
            }
            // Always safe to call even if no SSE client ever connected -
            // notificationBus.close() only quits connections that were
            // actually opened (unlike priceRefresherQueue above, this
            // isn't gated on config.redis.enabled: in local-only mode it
            // never opened any Redis connection to begin with, so this is
            // just a harmless no-op rather than something to skip).
            await notificationBus.close();
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

// Exported so start()/shutdown() can be unit tested directly (with
// connectDB/app.listen/etc. mocked) without registering real global
// process handlers or actually booting - see the require.main guard
// below. This is the same "importable/testable without side effects"
// property this file's own header comment already claims for app.js,
// extended to server.js itself.
module.exports = { start, shutdown };

// Only register real signal handlers and actually start the server when
// this file is the process entry point (`node server.js` / `npm start`)
// - NOT when required by a test (`require('../../server')`), where
// registering process-level 'uncaughtException'/'unhandledRejection'
// handlers that call process.exit() would be actively dangerous
// (Jest's own process must not be killed by a handler meant for the
// real app process).
if (require.main === module) {
    process.on('SIGINT', function() { shutdown('SIGINT'); }); // Ctrl+C locally
    process.on('SIGTERM', function() { shutdown('SIGTERM'); }); // container/platform stop signal

    // ── Last line of defense for errors outside Express's request
    // lifecycle - NOT a substitute for asyncHandler/errorHandler, which
    // correctly handle the vast majority of errors already ────────────
    process.on('unhandledRejection', function(reason) {
        logger.error('Unhandled promise rejection', reason instanceof Error ? reason : new Error(String(reason)));
        process.exit(1);
    });

    process.on('uncaughtException', function(err) {
        logger.error('Uncaught exception', err);
        process.exit(1);
    });

    start();
}