// tests/integration/routes/notification.routes.test.js
//
// Route-level tests for the notification endpoints. Every route
// requires auth. Notifications are seeded directly via the model here
// (normally created as a side effect of alert.service.js's
// checkAndTriggerAlerts) since this file is testing the routes, not the
// trigger flow itself - that's covered by alert.service.test.js.

'use strict';

const request = require('supertest');
const mongoose = require('mongoose');
const config = require('../../../src/config/env');
const User = require('../../../src/models/User.model');
const Notification = require('../../../src/models/Notification.model');
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