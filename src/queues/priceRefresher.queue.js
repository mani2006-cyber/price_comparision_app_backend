// src/queues/priceRefresher.queue.js
//
// BullMQ wiring for the price-refresher job. priceRefresher.job.js still
// owns what a "refresh run" actually DOES (runOnce()) - this file only
// owns WHEN/HOW it runs: a repeatable job on a BullMQ Queue, processed
// by a Worker, instead of a bare node-cron timer calling runOnce()
// directly in-process. That buys retry-on-failure, a persisted job
// history (visible via any BullMQ UI pointed at the same Redis), and a
// clean separation between "the process that decided a refresh should
// happen now" and "the process that actually ran it" - which matters
// once this app ever runs more than one instance, where a bare
// node-cron timer would fire the SAME job redundantly in every
// instance.
//
// Requires Redis - BullMQ has no in-memory fallback. server.js only
// calls start() when config.redis.enabled is true; priceRefresher.job.js
// itself remains as the node-cron fallback for when Redis isn't
// available (e.g. the test environment, or a minimal local setup),
// preserving "the app still works without Redis" for this job the same
// way caching already degrades gracefully without it (src/config/redis.js).
//
// Nothing in this file runs at require()-time - no Redis connection is
// opened just by requiring this module, only by calling start()/getQueue()
// - so it's always safe to require from anywhere (including tests that
// mock 'bullmq'/'ioredis' entirely and never call start()).

'use strict';

const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');
const config = require('../config/env');
const logger = require('../utils/logger');
const priceRefresherJob = require('../jobs/priceRefresher.job');

const QUEUE_NAME = 'price-refresher';
const REPEATABLE_JOB_NAME = 'run-price-refresher';

// BullMQ manages its own Redis key namespacing internally and refuses to
// start at all if the ioredis connection itself carries a `keyPrefix`
// (throws "ioredis does not support ioredis prefixes, use the prefix
// option instead" - confirmed against a real Redis instance, not just
// docs). config.redis.keyPrefix (e.g. "pricecompare:") is this app's
// OWN cache-key convention (src/config/redis.js) - reusing it here as
// BullMQ's own `prefix` option keeps every key this app writes under
// one shared namespace without violating that rule, just via the
// mechanism BullMQ actually wants. Trailing ":" stripped since BullMQ
// joins prefix + ":" + queueName itself.
const BULLMQ_PREFIX = config.redis.keyPrefix.replace(/:+$/, '') || 'bullmq';

let connection = null;
let queue = null;
let worker = null;

function getConnection() {
    if (!connection) {
        connection = new IORedis(config.redis.url, {
            // BullMQ's own hard requirement, not this app's usual Redis
            // client setting (config/redis.js uses maxRetriesPerRequest: 1
            // for the cache, deliberately different) - BullMQ manages
            // blocking-connection retries itself and throws at Worker
            // construction time if this isn't null.
            maxRetriesPerRequest: null,
        });
    }
    return connection;
}

function getQueue() {
    if (!queue) {
        queue = new Queue(QUEUE_NAME, { connection: getConnection(), prefix: BULLMQ_PREFIX });
    }
    return queue;
}

// Wires a Worker that runs the job's existing, already-tested runOnce()
// logic - BullMQ owns scheduling/retry/concurrency here, the actual
// "find stale products and re-fetch them" behavior is untouched.
function startWorker() {
    if (worker) {
        return worker;
    }

    worker = new Worker(
        QUEUE_NAME,
        async function() {
            return priceRefresherJob.runOnce();
        },
        { connection: getConnection(), concurrency: 1, prefix: BULLMQ_PREFIX }
    );

    worker.on('completed', function(job, result) {
        logger.info('Price refresher queue: job completed', { jobId: job.id, result });
    });

    worker.on('failed', function(job, err) {
        logger.error('Price refresher queue: job failed', {
            jobId: job && job.id,
            message: err.message,
        });
    });

    return worker;
}

// Registers the recurring schedule using BullMQ's "Job Scheduler" API -
// upsertJobScheduler(), NOT queue.add(name, data, { repeat }). That
// older repeat-on-add form is what BullMQ's own docs/most tutorials
// still show, and it doesn't throw here either - but verified directly
// against a real Redis instance, it silently registers nothing this
// installed BullMQ major version's own getJobSchedulers() can see, i.e.
// no recurring job actually gets created. upsertJobScheduler is the
// real, current mechanism (also confirmed against the same Redis
// instance - the queue's own schedulers list shows the registration
// afterwards). A real cron pattern - config.priceRefresher.cronSchedule,
// the same value node-cron used before - drives it, replacing node-cron
// entirely on this path.
//
// "upsert", not "add": calling this again on every boot updates the
// existing scheduler in place (keyed by REPEATABLE_JOB_NAME) rather than
// stacking up duplicates, so a process restart is always safe.
async function scheduleRepeating() {
    await getQueue().upsertJobScheduler(
        REPEATABLE_JOB_NAME,
        { pattern: config.priceRefresher.cronSchedule },
        {
            name: REPEATABLE_JOB_NAME,
            opts: { removeOnComplete: 20, removeOnFail: 50 },
        }
    );

    logger.info('Price refresher queue: repeating schedule registered', {
        cronSchedule: config.priceRefresher.cronSchedule,
    });
}

async function start() {
    startWorker();
    await scheduleRepeating();
}

async function close() {
    if (worker) {
        await worker.close();
        worker = null;
    }
    if (queue) {
        await queue.close();
        queue = null;
    }
    if (connection) {
        await connection.quit();
        connection = null;
    }
}

module.exports = { start, close, startWorker, scheduleRepeating, getQueue };
