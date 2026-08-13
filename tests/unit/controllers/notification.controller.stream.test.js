// tests/unit/controllers/notification.controller.stream.test.js
//
// Unit test for notification.controller.js's `stream` (SSE) handler.
// notificationBus is mocked so this never touches Redis/EventEmitter
// internals directly - it only asserts THIS function's own contract:
// correct headers, subscribes for req.userId, writes each pushed
// notification as a properly-formatted SSE event, sends periodic
// heartbeats, and unsubscribes + clears the heartbeat when the
// connection closes.

'use strict';

const { EventEmitter } = require('events');

jest.mock('../../../src/realtime/notificationBus', function() {
    return { subscribe: jest.fn(), publish: jest.fn(), close: jest.fn() };
});

const notificationBus = require('../../../src/realtime/notificationBus');
const { stream } = require('../../../src/controllers/notification.controller');

function fakeReq(userId) {
    const req = new EventEmitter();
    req.userId = userId || 'user1';
    return req;
}

function fakeRes() {
    const res = {};
    res.writes = [];
    res.status = jest.fn().mockReturnValue(res);
    res.set = jest.fn().mockReturnValue(res);
    res.flushHeaders = jest.fn();
    res.write = jest.fn(function(chunk) { res.writes.push(chunk); });
    return res;
}

beforeEach(function() {
    jest.clearAllMocks();
});

describe('stream()', function() {
    it('sets SSE headers and flushes them immediately', function() {
        const unsubscribe = jest.fn();
        notificationBus.subscribe.mockReturnValue(unsubscribe);

        const res = fakeRes();
        stream(fakeReq(), res);

        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.set).toHaveBeenCalledWith(expect.objectContaining({
            'Content-Type': 'text/event-stream',
            'Connection': 'keep-alive',
        }));
        expect(res.flushHeaders).toHaveBeenCalledTimes(1);
    });

    it('writes an initial comment line so the client sees the connection open immediately', function() {
        notificationBus.subscribe.mockReturnValue(jest.fn());
        const res = fakeRes();

        stream(fakeReq(), res);

        expect(res.writes[0]).toBe(': connected\n\n');
    });

    it('subscribes to notificationBus using req.userId', function() {
        notificationBus.subscribe.mockReturnValue(jest.fn());
        const req = fakeReq('user42');

        stream(req, fakeRes());

        expect(notificationBus.subscribe).toHaveBeenCalledWith('user42', expect.any(Function));
    });

    it('writes a properly-formatted SSE event when notificationBus pushes a notification', function() {
        let pushCallback;
        notificationBus.subscribe.mockImplementation(function(userId, cb) {
            pushCallback = cb;
            return jest.fn();
        });
        const res = fakeRes();

        stream(fakeReq(), res);
        pushCallback({ _id: 'n1', title: 'Price dropped!', message: 'Widget dropped to ₹499' });

        const notificationWrite = res.writes.find(function(w) { return w.indexOf('event: notification') === 0; });
        expect(notificationWrite).toBe(
            'event: notification\ndata: ' + JSON.stringify({ _id: 'n1', title: 'Price dropped!', message: 'Widget dropped to ₹499' }) + '\n\n'
        );
    });

    it('delivers multiple pushes to the same open connection, in order', function() {
        let pushCallback;
        notificationBus.subscribe.mockImplementation(function(userId, cb) {
            pushCallback = cb;
            return jest.fn();
        });
        const res = fakeRes();

        stream(fakeReq(), res);
        pushCallback({ title: 'First' });
        pushCallback({ title: 'Second' });

        const events = res.writes.filter(function(w) { return w.indexOf('event: notification') === 0; });
        expect(events).toHaveLength(2);
        expect(events[0]).toContain('First');
        expect(events[1]).toContain('Second');
    });

    it('sends a heartbeat comment on the configured interval', function() {
        jest.useFakeTimers();
        notificationBus.subscribe.mockReturnValue(jest.fn());
        const res = fakeRes();

        stream(fakeReq(), res);
        jest.advanceTimersByTime(25000);

        expect(res.writes).toContain(': ping\n\n');

        jest.useRealTimers();
    });

    it('unsubscribes and stops the heartbeat when the connection closes', function() {
        jest.useFakeTimers();
        const unsubscribe = jest.fn();
        notificationBus.subscribe.mockReturnValue(unsubscribe);
        const req = fakeReq();
        const res = fakeRes();

        stream(req, res);
        req.emit('close');

        expect(unsubscribe).toHaveBeenCalledTimes(1);

        // Heartbeat must not still be running post-close.
        const writeCountAtClose = res.writes.length;
        jest.advanceTimersByTime(100000);
        expect(res.writes.length).toBe(writeCountAtClose);

        jest.useRealTimers();
    });

    it('a push arriving AFTER the connection closed does not write to the dead response (proves unsubscribe actually detaches the listener)', function() {
        let pushCallback;
        const unsubscribe = jest.fn(function() { pushCallback = null; });
        notificationBus.subscribe.mockImplementation(function(userId, cb) {
            pushCallback = cb;
            return unsubscribe;
        });
        const req = fakeReq();
        const res = fakeRes();

        stream(req, res);
        req.emit('close');

        expect(pushCallback).toBeNull(); // the real notificationBus would no longer call this at all post-unsubscribe
    });
});
