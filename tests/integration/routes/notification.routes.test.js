// tests/integration/routes/notification.routes.test.js
//
// Route-level tests for the notification endpoints. Every route
// requires auth. Notifications are seeded directly via the model here
// (normally created as a side effect of alert.service.js's
// checkAndTriggerAlerts) since this file is testing the routes, not the
// trigger flow itself - that's covered by alert.service.test.js.
//
// src/utils/cache is mocked (same pattern as
// tests/integration/middleware/cache.middleware.test.js) so the GET /
// caching behavior added to this route is deterministic and doesn't
// depend on a real Redis instance. Default resolved values are set in
// beforeEach so every OTHER test in this file (which predates caching)
// keeps behaving exactly as it did before - a mocked cache.get()
// resolving to null is functionally identical to the real thing's
// no-op-when-Redis-disabled behavior these tests already ran under.

'use strict';

jest.mock('../../../src/utils/cache');

const request = require('supertest');
const mongoose = require('mongoose');
const config = require('../../../src/config/env');
const User = require('../../../src/models/User.model');
const Notification = require('../../../src/models/Notification.model');
const cache = require('../../../src/utils/cache');
const app = require('../../../src/app');

const EMAIL_A = 'routetest-notif-a@example.com';
const EMAIL_B = 'routetest-notif-b@example.com';

let userA;
let userB;
let tokenA;
let tokenB;

beforeAll(async function() {
    await mongoose.connect(config.mongoUri);
});

afterAll(async function() {
    await mongoose.disconnect();
});

beforeEach(async function() {
    jest.clearAllMocks();
    cache.get.mockResolvedValue(null); // default: every request is a cache MISS unless a test overrides this
    cache.set.mockResolvedValue(true);
    cache.del.mockResolvedValue(true);

    await User.deleteMany({ email: { $in: [EMAIL_A, EMAIL_B] } });

    const signupA = await request(app).post('/api/auth/signup').send({ name: 'A', email: EMAIL_A, password: 'plaintext123' });
    const signupB = await request(app).post('/api/auth/signup').send({ name: 'B', email: EMAIL_B, password: 'plaintext123' });
    tokenA = signupA.body.accessToken;
    tokenB = signupB.body.accessToken;
    userA = await User.findOne({ email: EMAIL_A });
    userB = await User.findOne({ email: EMAIL_B });

    await Notification.deleteMany({ userId: { $in: [userA._id, userB._id] } });
});

describe('GET /api/notifications', function() {
    it('rejects a request with no access token', async function() {
        const res = await request(app).get('/api/notifications');
        expect(res.status).toBe(401);
    });

    it('returns the notification list AND unread count together', async function() {
        await Notification.create({ userId: userA._id, type: 'system', title: 'Welcome', message: 'welcome msg' });
        await Notification.create({ userId: userA._id, type: 'price_drop', title: 'Drop', message: 'price drop msg' });

        const res = await request(app).get('/api/notifications').set('Authorization', 'Bearer ' + tokenA);

        expect(res.status).toBe(200);
        expect(res.body.notifications).toHaveLength(2);
        expect(res.body.unreadCount).toBe(2);
    });

    it('only returns notifications belonging to the requesting user', async function() {
        await Notification.create({ userId: userA._id, type: 'system', title: 'A', message: 'a' });
        await Notification.create({ userId: userB._id, type: 'system', title: 'B', message: 'b' });

        const res = await request(app).get('/api/notifications').set('Authorization', 'Bearer ' + tokenA);

        expect(res.body.notifications).toHaveLength(1);
        expect(res.body.notifications[0].title).toBe('A');
    });
});

describe('POST /api/notifications/:id/read', function() {
    it('marks a notification as read for its owner', async function() {
        const n = await Notification.create({ userId: userA._id, type: 'system', title: 'A', message: 'a' });

        const res = await request(app)
            .post('/api/notifications/' + n._id + '/read')
            .set('Authorization', 'Bearer ' + tokenA);

        expect(res.status).toBe(200);
        expect(res.body.notification.isRead).toBe(true);
    });

    it('rejects marking a different user\'s notification with a 404', async function() {
        const n = await Notification.create({ userId: userA._id, type: 'system', title: 'A', message: 'a' });

        const res = await request(app)
            .post('/api/notifications/' + n._id + '/read')
            .set('Authorization', 'Bearer ' + tokenB);

        expect(res.status).toBe(404);
    });

    it('rejects a fake notification id with a 404', async function() {
        const res = await request(app)
            .post('/api/notifications/000000000000000000000000/read')
            .set('Authorization', 'Bearer ' + tokenA);

        expect(res.status).toBe(404);
    });
});

describe('POST /api/notifications/read-all', function() {
    it('marks every unread notification for the caller and reports the count', async function() {
        await Notification.create({ userId: userA._id, type: 'system', title: 'A', message: 'a' });
        await Notification.create({ userId: userA._id, type: 'system', title: 'B', message: 'b' });
        await Notification.create({ userId: userB._id, type: 'system', title: 'C', message: 'c' }); // different user - unaffected

        const res = await request(app).post('/api/notifications/read-all').set('Authorization', 'Bearer ' + tokenA);

        expect(res.status).toBe(200);
        expect(res.body.modifiedCount).toBe(2);

        const inboxA = await request(app).get('/api/notifications').set('Authorization', 'Bearer ' + tokenA);
        expect(inboxA.body.unreadCount).toBe(0);

        const inboxB = await request(app).get('/api/notifications').set('Authorization', 'Bearer ' + tokenB);
        expect(inboxB.body.unreadCount).toBe(1); // untouched
    });
});

describe('GET /api/notifications caching', function() {
    it('sets X-Cache: MISS and stores the response on a cache miss', async function() {
        await Notification.create({ userId: userA._id, type: 'system', title: 'A', message: 'a' });

        const res = await request(app).get('/api/notifications').set('Authorization', 'Bearer ' + tokenA);

        expect(res.status).toBe(200);
        expect(res.headers['x-cache']).toBe('MISS');
        expect(cache.get).toHaveBeenCalledWith('notifications:' + userA._id);
        expect(cache.set).toHaveBeenCalledTimes(1);
    });

    it('returns the cached body directly with X-Cache: HIT, without touching the DB result', async function() {
        const cachedBody = { success: true, unreadCount: 5, notifications: [] };
        cache.get.mockResolvedValue(cachedBody);

        const res = await request(app).get('/api/notifications').set('Authorization', 'Bearer ' + tokenA);

        expect(res.status).toBe(200);
        expect(res.headers['x-cache']).toBe('HIT');
        expect(res.body).toEqual(cachedBody);
    });

    it('bypasses the cache entirely when a custom ?limit= is requested', async function() {
        cache.get.mockResolvedValue({ success: true, unreadCount: 999, notifications: ['should never be returned'] });
        await Notification.create({ userId: userA._id, type: 'system', title: 'A', message: 'a' });

        const res = await request(app).get('/api/notifications').query({ limit: 1 }).set('Authorization', 'Bearer ' + tokenA);

        expect(res.status).toBe(200);
        expect(res.body.unreadCount).not.toBe(999); // real data, not the cached stand-in
        expect(cache.get).not.toHaveBeenCalled();
    });

    it('marking a notification read invalidates the cached inbox for that user', async function() {
        const n = await Notification.create({ userId: userA._id, type: 'system', title: 'A', message: 'a' });

        await request(app).post('/api/notifications/' + n._id + '/read').set('Authorization', 'Bearer ' + tokenA);

        expect(cache.del).toHaveBeenCalledWith('notifications:' + userA._id);
    });

    it('mark-all-as-read invalidates the cached inbox for that user only, not other users', async function() {
        await Notification.create({ userId: userA._id, type: 'system', title: 'A', message: 'a' });

        await request(app).post('/api/notifications/read-all').set('Authorization', 'Bearer ' + tokenA);

        expect(cache.del).toHaveBeenCalledWith('notifications:' + userA._id);
        expect(cache.del).not.toHaveBeenCalledWith('notifications:' + userB._id);
    });
});

// The "valid token successfully opens a real SSE stream" case is
// deliberately NOT tested here via a live supertest request - forcibly
// aborting a genuinely-open-ended stream mid-test (the only way to end
// one) reliably triggers a stray async error that escapes past the
// test's own resolution and gets attributed to the whole suite ("●
// Test suite failed to run: aborted") even though the test's own
// assertions already passed, discovered by actually trying it. The auth
// rejection paths below are still verified end-to-end (normal
// request/response, no streaming involved since the middleware rejects
// before the handler ever opens the stream); the stream's actual
// behavior once opened - correct headers, delivering pushed
// notifications, heartbeats, cleanup on close - is covered
// deterministically instead by
// tests/unit/controllers/notification.controller.stream.test.js and
// tests/unit/realtime/notificationBus.test.js, neither of which needs a
// real open connection to verify real behavior.
describe('GET /api/notifications/stream', function() {
    it('rejects a request with no token at all (neither header nor query) with a 401', async function() {
        const res = await request(app).get('/api/notifications/stream');
        expect(res.status).toBe(401);
    });

    it('rejects an invalid token with a 401', async function() {
        const res = await request(app).get('/api/notifications/stream').query({ token: 'not-a-real-token' });
        expect(res.status).toBe(401);
    });
});