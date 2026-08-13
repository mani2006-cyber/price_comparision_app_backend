// tests/unit/queues/priceRefresher.queue.test.js
//
// Unit tests for priceRefresher.queue.js - 'bullmq', 'ioredis', and the
// underlying job module are all mocked, so this suite needs no real
// Redis connection (matching this project's "tests never depend on a
// running Redis instance" rule - see .env.test's own comment on
// REDIS_ENABLED). Verifies the WIRING: which BullMQ APIs get called,
// with what arguments - not BullMQ's own internals.

'use strict';

const mockQueueInstance = {
    upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
};
const mockWorkerInstance = {
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
};
const mockRedisInstance = {
    quit: jest.fn().mockResolvedValue(undefined),
};

const mockQueueCtor = jest.fn(function() { return mockQueueInstance; });
const mockWorkerCtor = jest.fn(function(name, processor) {
    mockWorkerInstance.__processor = processor; // capture the job processor for direct invocation in tests
    return mockWorkerInstance;
});

jest.mock('bullmq', function() {
    return { Queue: mockQueueCtor, Worker: mockWorkerCtor };
});
jest.mock('ioredis', function() {
    return jest.fn(function() { return mockRedisInstance; });
});
jest.mock('../../../src/jobs/priceRefresher.job', function() {
    return { runOnce: jest.fn().mockResolvedValue({ total: 0, succeeded: 0, failed: 0 }) };
});

const IORedis = require('ioredis');
const config = require('../../../src/config/env');
const priceRefresherJob = require('../../../src/jobs/priceRefresher.job');
const priceRefresherQueue = require('../../../src/queues/priceRefresher.queue');

beforeEach(function() {
    jest.clearAllMocks();
});

afterEach(async function() {
    // Reset the module's internal singletons between tests so each test
    // gets a fresh getConnection()/getQueue() instead of the previous
    // test's cached ones - close() is exactly the reset path the real
    // app's shutdown hook uses too, so this exercises real behavior.
    await priceRefresherQueue.close();
});

describe('getQueue', function() {
    it('constructs a BullMQ Queue named "price-refresher" with an ioredis connection and a prefix', function() {
        priceRefresherQueue.getQueue();

        expect(mockQueueCtor).toHaveBeenCalledWith('price-refresher', expect.objectContaining({
            connection: mockRedisInstance,
            prefix: expect.any(String),
        }));
    });

    it('passes maxRetriesPerRequest: null to ioredis - BullMQ throws at construction time without it', function() {
        priceRefresherQueue.getQueue();

        expect(IORedis).toHaveBeenCalledWith(
            config.redis.url,
            expect.objectContaining({ maxRetriesPerRequest: null })
        );
    });

    it('is memoized - repeated calls reuse the same Queue/connection instance', function() {
        priceRefresherQueue.getQueue();
        priceRefresherQueue.getQueue();

        expect(mockQueueCtor).toHaveBeenCalledTimes(1);
        expect(IORedis).toHaveBeenCalledTimes(1);
    });
});

describe('scheduleRepeating', function() {
    it('registers a recurring job via upsertJobScheduler using config.priceRefresher.cronSchedule as the pattern', async function() {
        await priceRefresherQueue.scheduleRepeating();

        expect(mockQueueInstance.upsertJobScheduler).toHaveBeenCalledWith(
            'run-price-refresher',
            { pattern: config.priceRefresher.cronSchedule },
            expect.objectContaining({ name: 'run-price-refresher' })
        );
    });

    it('does NOT use the legacy queue.add(name, data, { repeat }) form - upsertJobScheduler is the only scheduling call made', async function() {
        await priceRefresherQueue.scheduleRepeating();
        expect(mockQueueInstance.upsertJobScheduler).toHaveBeenCalledTimes(1);
    });
});

describe('startWorker', function() {
    it('constructs a Worker for the same queue name, with concurrency 1', function() {
        priceRefresherQueue.startWorker();

        expect(mockWorkerCtor).toHaveBeenCalledWith(
            'price-refresher',
            expect.any(Function),
            expect.objectContaining({ concurrency: 1 })
        );
    });

    it('registers completed/failed listeners', function() {
        priceRefresherQueue.startWorker();

        const registeredEvents = mockWorkerInstance.on.mock.calls.map(function(call) { return call[0]; });
        expect(registeredEvents).toEqual(expect.arrayContaining(['completed', 'failed']));
    });

    it('is memoized - calling it twice does not construct a second Worker', function() {
        priceRefresherQueue.startWorker();
        priceRefresherQueue.startWorker();

        expect(mockWorkerCtor).toHaveBeenCalledTimes(1);
    });

    it('the Worker\'s job processor calls priceRefresherJob.runOnce() - BullMQ owns scheduling, the job module still owns the actual work', async function() {
        priceRefresherQueue.startWorker();

        await mockWorkerInstance.__processor();

        expect(priceRefresherJob.runOnce).toHaveBeenCalledTimes(1);
    });
});

describe('start', function() {
    it('starts the worker and registers the repeating schedule', async function() {
        await priceRefresherQueue.start();

        expect(mockWorkerCtor).toHaveBeenCalledTimes(1);
        expect(mockQueueInstance.upsertJobScheduler).toHaveBeenCalledTimes(1);
    });
});

describe('close', function() {
    it('closes the worker, queue, and quits the redis connection', async function() {
        priceRefresherQueue.startWorker();
        priceRefresherQueue.getQueue();

        await priceRefresherQueue.close();

        expect(mockWorkerInstance.close).toHaveBeenCalledTimes(1);
        expect(mockQueueInstance.close).toHaveBeenCalledTimes(1);
        expect(mockRedisInstance.quit).toHaveBeenCalledTimes(1);
    });

    it('is safe to call when nothing was ever started (no-op, does not throw)', async function() {
        await expect(priceRefresherQueue.close()).resolves.toBeUndefined();
    });
});
