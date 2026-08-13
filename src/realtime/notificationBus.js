// src/realtime/notificationBus.js
//
// Real-time fan-out for notifications: publish(userId, notification) ->
// every currently-open connection subscribed to that user (via
// subscribe()) receives it immediately. This is the piece that makes
// "a new notification is pushed live to that user's active connection"
// true - see notification.controller.js's `stream` handler (the SSE
// endpoint that calls subscribe()) and notification.repository.js
// (the ONLY place that calls publish() - every notification-creation
// path already funnels through that one file, so wiring the push in
// there guarantees no caller can create a notification without also
// triggering the push, structurally, not by convention).
//
// Two delivery modes, chosen automatically by config.redis.enabled -
// same "Redis is optional infrastructure" posture as caching
// (src/config/redis.js) and the price-refresher queue
// (src/queues/priceRefresher.queue.js):
//
//   - Redis DISABLED (or a minimal single-instance setup): publish()
//     hands the notification directly to the in-process EventEmitter
//     (localBus) below. Works correctly as long as the publishing
//     process and the subscribed connection are the same process -
//     true for this app's normal deployment shape.
//
//   - Redis ENABLED: publish() sends the notification over a Redis
//     Pub/Sub channel instead of emitting locally itself. A single
//     dedicated subscriber connection (started lazily, the first time
//     anything calls subscribe()) receives every message published by
//     ANY process - this one or another horizontally-scaled instance -
//     and is what actually feeds localBus. This is what lets a
//     notification created by, say, the price-refresher's BullMQ
//     Worker reach a user's SSE connection that happens to be held open
//     on a *different* API instance. publish() does NOT also emit
//     locally in this mode - Redis delivers a publisher's own message
//     back to its own subscriber connection just like any other
//     subscriber, so emitting both ways would deliver every
//     notification twice to a same-process listener.
//
// Both Redis connections used here (publisher and subscriber) are
// created WITHOUT config.redis.keyPrefix - deliberately. ioredis's
// keyPrefix rewrites more than plain key arguments in some versions,
// and this project already hit that exact class of bug once this
// session (BullMQ's Queue/Worker connection - see
// priceRefresher.queue.js's own comment on it): a channel name silently
// rewritten differently between the publisher and subscriber would
// break delivery with zero errors on either side. Using a fixed literal
// channel name with un-prefixed connections sidesteps the ambiguity
// entirely rather than re-verifying it's safe this time too.

'use strict';

const { EventEmitter } = require('events');
const Redis = require('ioredis');
const config = require('../config/env');
const logger = require('../utils/logger');

const CHANNEL = 'app:notifications';

// Every subscribe() call registers here, regardless of delivery mode -
// the ONE fan-out point every SSE connection listens through.
// Unbounded listener count: one listener per concurrent open
// connection is expected and correct, not a leak Node should warn
// about (the default cap is 10).
const localBus = new EventEmitter();
localBus.setMaxListeners(0);

let publisher = null;
let subscriber = null;

function getPublisher() {
    if (!publisher) {
        publisher = new Redis(config.redis.url);
        publisher.on('error', function(err) {
            logger.warn('Notification bus: publisher connection error', { message: err.message });
        });
    }
    return publisher;
}

// Lazily started on the FIRST subscribe() call (not at module load, and
// not eagerly at process start) - requiring this file must never open a
// Redis connection by itself, same property priceRefresher.queue.js's
// getConnection() already established.
function ensureSubscriberStarted() {
    if (subscriber || !config.redis.enabled) {
        return;
    }

    subscriber = new Redis(config.redis.url);

    subscriber.on('error', function(err) {
        logger.warn('Notification bus: subscriber connection error', { message: err.message });
    });

    subscriber.subscribe(CHANNEL).catch(function(err) {
        logger.error('Notification bus: failed to subscribe to Redis channel', { message: err.message });
    });

    subscriber.on('message', function(channel, raw) {
        if (channel !== CHANNEL) {
            return;
        }

        let payload;
        try {
            payload = JSON.parse(raw);
        } catch (err) {
            logger.warn('Notification bus: dropped a malformed message', { message: err.message });
            return;
        }

        if (!payload || !payload.userId) {
            return;
        }

        localBus.emit(payload.userId, payload.notification);
    });
}

// ── Public API ───────────────────────────────────────────────────────

// Fire-and-forget by design, same as cache.set/cache.del - never
// throws, never delays the caller. A failed push just means the user
// sees the notification on their next poll/page load instead of
// instantly; the notification itself is already safely persisted in
// MongoDB by the time this is called (notification.repository.js calls
// this AFTER Notification.create() succeeds, never before).
function publish(userId, notification) {
    const userKey = String(userId);

    if (config.redis.enabled) {
        const payload = JSON.stringify({ userId: userKey, notification });
        getPublisher().publish(CHANNEL, payload).catch(function(err) {
            logger.warn('Notification bus: Redis publish failed, falling back to local-only delivery', {
                message: err.message,
            });
            // Redis is down/unreachable right now - still deliver to a
            // same-process listener rather than silently dropping the
            // push entirely just because the cross-instance path failed.
            localBus.emit(userKey, notification);
        });
        return;
    }

    localBus.emit(userKey, notification);
}

// Subscribes to real-time notifications for one user. Returns an
// unsubscribe function - callers (the SSE route) MUST call it when the
// connection closes, or the listener closure (which holds a reference
// to that connection's `res`) leaks for the lifetime of the process.
function subscribe(userId, onNotification) {
    ensureSubscriberStarted();
    const userKey = String(userId);
    localBus.on(userKey, onNotification);
    return function unsubscribe() {
        localBus.off(userKey, onNotification);
    };
}

// Closes both Redis connections (if they were ever opened) - called
// from server.js's graceful shutdown, same pattern as
// priceRefresherQueue.close().
async function close() {
    if (subscriber) {
        await subscriber.quit().catch(function() {});
        subscriber = null;
    }
    if (publisher) {
        await publisher.quit().catch(function() {});
        publisher = null;
    }
}

module.exports = { publish, subscribe, close };
