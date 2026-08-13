// tests/unit/server.test.js
//
// Unit tests for server.js's start()/shutdown() logic - everything it
// touches (Mongo, the HTTP listener, Redis, the price-refresher
// queue/job) is mocked, so this needs no real network/DB/Redis and
// never actually boots a server or registers real process signal
// handlers (server.js's own require.main guard - see its header
// comment - only does that when run directly, not when required here).
//
// This is the test that would have caught the graceful-shutdown gap
// flagged in the previous session: attempting to verify shutdown() by
// sending a real SIGINT to a live `node server.js` process on Windows
// didn't reliably trigger the JS-level handler at all (a known Node-on-
// Windows cross-process signal-emulation limitation, not a code bug) -
// calling shutdown() directly, as a plain function, sidesteps that
// platform issue entirely and is the more reliable test regardless of
// platform.

'use strict';

jest.mock('../../src/config/db', function() {
    return { connectDB: jest.fn(), disconnectDB: jest.fn() };
});
jest.mock('../../src/config/redis', function() {
    return { disconnectRedis: jest.fn() };
});
jest.mock('../../src/jobs/priceRefresher.job', function() {
    return { start: jest.fn() };
});
jest.mock('../../src/queues/priceRefresher.queue', function() {
    return { start: jest.fn(), close: jest.fn() };
});
jest.mock('../../src/realtime/notificationBus', function() {
    return { publish: jest.fn(), subscribe: jest.fn(), close: jest.fn() };
});
jest.mock('../../src/app', function() {
    return { listen: jest.fn() };
});

function mockServerInstance() {
    return { close: jest.fn(function(cb) { if (cb) cb(); }) };
}

// jest.resetModules() is the only Jest-blessed way to give server.js a
// truly fresh closure-level `let server;` between tests - but it also
// invalidates EVERY already-required module, including ones never
// explicitly mocked, like src/config/env.js. Holding `config` (or
// `connectDB`/`app`/etc.) as a module-top-level const - the usual
// pattern - would leave that const pointing at a STALE instance after
// the first reset, different from the fresh one server.js itself
// re-requires internally; mutating config.redis.enabled on the stale
// object would then silently have no effect on the code actually under
// test (this bit early drafts of this file: every "starts the BullMQ
// queue when Redis is enabled"-style assertion failed even though the
// real code path was correct). Re-requiring EVERY dependency fresh
// INSIDE loadServer(), right alongside server.js itself, keeps them all
// pointed at the same instances server.js is actually calling.
function loadServer(options) {
    jest.resetModules();

    const config = require('../../src/config/env');
    if (options && options.redisEnabled !== undefined) {
        config.redis.enabled = options.redisEnabled;
    }

    const deps = {
        config,
        connectDB: require('../../src/config/db').connectDB,
        disconnectDB: require('../../src/config/db').disconnectDB,
        disconnectRedis: require('../../src/config/redis').disconnectRedis,
        priceRefresherJob: require('../../src/jobs/priceRefresher.job'),
        priceRefresherQueue: require('../../src/queues/priceRefresher.queue'),
        notificationBus: require('../../src/realtime/notificationBus'),
        app: require('../../src/app'),
    };

    deps.connectDB.mockResolvedValue(undefined);
    deps.disconnectDB.mockResolvedValue(undefined);
    deps.disconnectRedis.mockResolvedValue(undefined);
    deps.priceRefresherQueue.start.mockResolvedValue(undefined);
    deps.priceRefresherQueue.close.mockResolvedValue(undefined);
    deps.notificationBus.close.mockResolvedValue(undefined);
    deps.app.listen.mockImplementation(function(port, cb) {
        if (cb) cb();
        return mockServerInstance();
    });

    const server = require('../../server');
    return { server, deps };
}

let processExitSpy;

beforeEach(function() {
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation(function() {});
});

afterEach(function() {
    processExitSpy.mockRestore();
});

describe('start()', function() {
    it('connects to Mongo, then listens on config.port', async function() {
        const { server, deps } = loadServer();
        await server.start();

        expect(deps.connectDB).toHaveBeenCalledTimes(1);
        expect(deps.app.listen).toHaveBeenCalledWith(deps.config.port, expect.any(Function));
    });

    it('exits with code 1 and never calls app.listen when connectDB fails', async function() {
        const { server, deps } = loadServer();
        deps.connectDB.mockRejectedValue(new Error('ECONNREFUSED'));

        await server.start();

        expect(processExitSpy).toHaveBeenCalledWith(1);
        expect(deps.app.listen).not.toHaveBeenCalled();
    });

    it('starts the BullMQ price-refresher queue when Redis is enabled', async function() {
        const { server, deps } = loadServer({ redisEnabled: true });

        await server.start();
        await Promise.resolve(); // let the .listen callback's async work settle

        expect(deps.priceRefresherQueue.start).toHaveBeenCalledTimes(1);
        expect(deps.priceRefresherJob.start).not.toHaveBeenCalled();
    });

    it('falls back to the node-cron job when Redis is disabled', async function() {
        const { server, deps } = loadServer({ redisEnabled: false });

        await server.start();

        expect(deps.priceRefresherJob.start).toHaveBeenCalledTimes(1);
        expect(deps.priceRefresherQueue.start).not.toHaveBeenCalled();
    });

    it('falls back to the node-cron job when the BullMQ queue fails to start', async function() {
        const { server, deps } = loadServer({ redisEnabled: true });
        deps.priceRefresherQueue.start.mockRejectedValue(new Error('Redis unreachable'));

        await server.start();
        await Promise.resolve().then(function() {}).then(function() {}); // let the rejection's .catch handler run

        expect(deps.priceRefresherJob.start).toHaveBeenCalledTimes(1);
    });
});

describe('shutdown()', function() {
    it('closes the price-refresher queue, disconnects Mongo and Redis, then exits 0', async function() {
        const { server, deps } = loadServer({ redisEnabled: true });
        await server.start();

        server.shutdown('SIGTERM');
        await new Promise(function(resolve) { setImmediate(resolve); }); // flush the server.close() callback's async chain

        expect(deps.priceRefresherQueue.close).toHaveBeenCalledTimes(1);
        expect(deps.notificationBus.close).toHaveBeenCalledTimes(1);
        expect(deps.disconnectDB).toHaveBeenCalledTimes(1);
        expect(deps.disconnectRedis).toHaveBeenCalledTimes(1);
        expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    it('does not touch the price-refresher queue when Redis was never enabled, but still closes the notification bus', async function() {
        const { server, deps } = loadServer({ redisEnabled: false });
        await server.start();

        server.shutdown('SIGTERM');
        await new Promise(function(resolve) { setImmediate(resolve); });

        expect(deps.priceRefresherQueue.close).not.toHaveBeenCalled();
        // Unlike the queue, notificationBus.close() is NOT gated on
        // config.redis.enabled - it's always safe/a no-op if nothing was
        // ever opened, so shutdown always calls it regardless.
        expect(deps.notificationBus.close).toHaveBeenCalledTimes(1);
        expect(deps.disconnectDB).toHaveBeenCalledTimes(1);
    });

    it('exits 0 immediately, without touching Mongo/Redis, when called before the server ever started', function() {
        const { server, deps } = loadServer(); // start() never called on this instance

        server.shutdown('SIGTERM');

        expect(processExitSpy).toHaveBeenCalledWith(0);
        expect(deps.disconnectDB).not.toHaveBeenCalled();
    });

    it('exits 1 when a disconnect step throws mid-shutdown', async function() {
        const { server, deps } = loadServer({ redisEnabled: true });
        deps.disconnectDB.mockRejectedValue(new Error('mongo disconnect failed'));
        await server.start();

        server.shutdown('SIGTERM');
        await new Promise(function(resolve) { setImmediate(resolve); });

        expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it('force-exits with code 1 if shutdown does not complete within the timeout', async function() {
        jest.useFakeTimers();
        const { server, deps } = loadServer({ redisEnabled: true });
        // server.close() never invokes its callback this time - simulates a
        // hung in-flight request that never finishes.
        deps.app.listen.mockImplementation(function(port, cb) {
            if (cb) cb();
            return { close: jest.fn() };
        });
        await server.start();

        server.shutdown('SIGTERM');
        jest.advanceTimersByTime(10001); // SHUTDOWN_TIMEOUT_MS + 1

        expect(processExitSpy).toHaveBeenCalledWith(1);

        jest.useRealTimers();
    });
});
