// tests/unit/realtime/notificationBus.test.js
//
// Unit tests for notificationBus.js. 'ioredis' is mocked, so this needs
// no real Redis connection. config.redis.enabled is read fresh on
// every publish()/subscribe() call (not cached at require-time), so
// these tests just flip it directly between cases - no module-registry
// gymnastics needed (unlike tests/unit/server.test.js, which DOES need
// that, because server.js's dependencies are captured once at
// require-time).

'use strict';

// Inlined directly in the jest.mock() factory, not a separate named
// function referenced from it - jest.mock() factories are hoisted
// above regular variable declarations, and referencing an out-of-scope
// helper here throws at transform time ("module factory... not allowed
// to reference any out-of-scope variables") unless its name happens to
// start with "mock".
jest.mock('ioredis', function() {
    return jest.fn().mockImplementation(function() {
        const handlers = {};
        return {
            on: jest.fn(function(event, cb) { handlers[event] = cb; }),
            subscribe: jest.fn().mockResolvedValue(undefined),
            publish: jest.fn().mockResolvedValue(1),
            quit: jest.fn().mockResolvedValue(undefined),
            // Test-only escape hatch: lets a test simulate Redis
            // delivering a message to this connection's subscriber, by
            // calling the exact handler notificationBus.js itself
            // registered via .on('message', ...).
            emitMessage: function(channel, raw) {
                if (handlers.message) handlers.message(channel, raw);
            },
        };
    });
});

const Redis = require('ioredis');
const config = require('../../../src/config/env');
const notificationBus = require('../../../src/realtime/notificationBus');

const ORIGINAL_REDIS_ENABLED = config.redis.enabled;

beforeEach(function() {
    Redis.mockClear();
});

afterEach(async function() {
    config.redis.enabled = ORIGINAL_REDIS_ENABLED;
    await notificationBus.close();
});

describe('local-only mode (Redis disabled)', function() {
    beforeEach(function() {
        config.redis.enabled = false;
    });

    it('delivers a published notification to a subscriber for the same user', function() {
        const received = [];
        const unsubscribe = notificationBus.subscribe('user1', function(n) { received.push(n); });

        notificationBus.publish('user1', { title: 'Hello' });

        expect(received).toEqual([{ title: 'Hello' }]);
        unsubscribe();
    });

    it('does NOT deliver to a subscriber for a different user', function() {
        const receivedForUser2 = [];
        notificationBus.subscribe('user2', function(n) { receivedForUser2.push(n); });

        notificationBus.publish('user1', { title: 'Not for user2' });

        expect(receivedForUser2).toEqual([]);
    });

    it('supports multiple simultaneous subscribers for the same user (e.g. two open tabs)', function() {
        const tab1 = [];
        const tab2 = [];
        notificationBus.subscribe('user1', function(n) { tab1.push(n); });
        notificationBus.subscribe('user1', function(n) { tab2.push(n); });

        notificationBus.publish('user1', { title: 'Both tabs' });

        expect(tab1).toHaveLength(1);
        expect(tab2).toHaveLength(1);
    });

    it('stops delivering after unsubscribe() is called', function() {
        const received = [];
        const unsubscribe = notificationBus.subscribe('user1', function(n) { received.push(n); });
        unsubscribe();

        notificationBus.publish('user1', { title: 'Too late' });

        expect(received).toEqual([]);
    });

    it('coerces a non-string userId (e.g. a Mongoose ObjectId) consistently between publish and subscribe', function() {
        const received = [];
        const fakeObjectId = { toString: function() { return 'abc123'; } };
        notificationBus.subscribe(fakeObjectId, function(n) { received.push(n); });

        notificationBus.publish('abc123', { title: 'X' });

        expect(received).toHaveLength(1);
    });

    it('never opens a Redis connection when Redis is disabled', function() {
        notificationBus.subscribe('user1', function() {});
        notificationBus.publish('user1', { title: 'X' });

        expect(Redis).not.toHaveBeenCalled();
    });
});

describe('Redis-backed mode (Redis enabled)', function() {
    beforeEach(function() {
        config.redis.enabled = true;
    });

    it('does not open any Redis connection just from requiring the module or before first use', function() {
        // Module was already required at file top - if it opened
        // connections eagerly, Redis would already have call history by
        // the time this test's own beforeEach even runs. Cleared calls in
        // the outer beforeEach, so a zero count here proves nothing opened
        // between then and now, before any publish/subscribe.
        expect(Redis).not.toHaveBeenCalled();
    });

    it('subscribe() lazily opens exactly one subscriber connection and issues SUBSCRIBE on the fixed channel', function() {
        notificationBus.subscribe('user1', function() {});

        expect(Redis).toHaveBeenCalledTimes(1);
        const subscriberConn = Redis.mock.results[0].value;
        expect(subscriberConn.subscribe).toHaveBeenCalledWith('app:notifications');
    });

    it('a second subscribe() call reuses the same subscriber connection, does not open another', function() {
        notificationBus.subscribe('user1', function() {});
        notificationBus.subscribe('user2', function() {});

        expect(Redis).toHaveBeenCalledTimes(1);
    });

    it('publish() sends to Redis, NOT directly to the local bus - avoids double delivery once the subscriber\'s own "message" event also fires', function() {
        const received = [];
        notificationBus.subscribe('user1', function(n) { received.push(n); }); // creates the subscriber connection (call #0)

        notificationBus.publish('user1', { title: 'Hello' }); // creates the publisher connection (call #1)

        const publisherConn = Redis.mock.results[1].value;
        expect(publisherConn.publish).toHaveBeenCalledWith('app:notifications', JSON.stringify({ userId: 'user1', notification: { title: 'Hello' } }));
        // Not delivered yet - only Redis was told; nothing has come back
        // through the subscriber's own "message" handler.
        expect(received).toEqual([]);
    });

    it('delivers to the correct user once the subscriber connection\'s "message" event fires (simulating Redis echoing the publish back)', function() {
        const received = [];
        notificationBus.subscribe('user1', function(n) { received.push(n); });
        const subscriberConn = Redis.mock.results[0].value;

        subscriberConn.emitMessage('app:notifications', JSON.stringify({ userId: 'user1', notification: { title: 'Hello' } }));

        expect(received).toEqual([{ title: 'Hello' }]);
    });

    it('is delivered EXACTLY ONCE per message, not twice - the real bug this design avoids', function() {
        const received = [];
        notificationBus.subscribe('user1', function(n) { received.push(n); });
        const subscriberConn = Redis.mock.results[0].value;

        // publish() itself must not ALSO emit locally - only the
        // subscriber's own message handler (simulated here) may.
        notificationBus.publish('user1', { title: 'Hello' });
        subscriberConn.emitMessage('app:notifications', JSON.stringify({ userId: 'user1', notification: { title: 'Hello' } }));

        expect(received).toHaveLength(1);
    });

    it('ignores a message on a different Redis channel', function() {
        const received = [];
        notificationBus.subscribe('user1', function(n) { received.push(n); });
        const subscriberConn = Redis.mock.results[0].value;

        subscriberConn.emitMessage('some-other-channel', JSON.stringify({ userId: 'user1', notification: { title: 'X' } }));

        expect(received).toEqual([]);
    });

    it('drops a malformed (non-JSON) message without throwing', function() {
        notificationBus.subscribe('user1', function() {});
        const subscriberConn = Redis.mock.results[0].value;

        expect(function() {
            subscriberConn.emitMessage('app:notifications', 'not valid json{{{');
        }).not.toThrow();
    });

    it('falls back to local-only delivery when the Redis publish itself fails', async function() {
        const received = [];
        notificationBus.subscribe('user1', function(n) { received.push(n); });
        const subscriberConn = Redis.mock.results[0].value;

        notificationBus.publish('user1', { title: 'X' }); // creates the publisher connection
        const publisherConn = Redis.mock.results[1].value;
        publisherConn.publish.mockRejectedValueOnce(new Error('Redis down'));

        notificationBus.publish('user1', { title: 'Y' });
        await Promise.resolve().then(function() {}).then(function() {}); // let the rejection's .catch handler run

        expect(received).toEqual([{ title: 'Y' }]);
        void subscriberConn; // unused directly, kept for clarity of what's NOT involved in this path
    });
});

describe('close()', function() {
    it('quits both connections if they were opened', async function() {
        config.redis.enabled = true;
        notificationBus.subscribe('user1', function() {});
        notificationBus.publish('user1', { title: 'X' });
        const subscriberConn = Redis.mock.results[0].value;
        const publisherConn = Redis.mock.results[1].value;

        await notificationBus.close();

        expect(subscriberConn.quit).toHaveBeenCalledTimes(1);
        expect(publisherConn.quit).toHaveBeenCalledTimes(1);
    });

    it('is safe to call when nothing was ever opened', async function() {
        await expect(notificationBus.close()).resolves.toBeUndefined();
    });
});
