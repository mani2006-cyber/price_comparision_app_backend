// tests/integration/services/notification.service.test.js
//
// Integration test for notification.service.js - no mocking needed,
// this is a thin wrapper over notification.repository.js (File 22),
// already tested directly. This confirms the service-layer 404
// translation and the combined getInbox shape.

'use strict';

const mongoose = require('mongoose');
const config = require('../../../src/config/env');
const User = require('../../../src/models/User.model');
const Notification = require('../../../src/models/Notification.model');
const notificationService = require('../../../src/services/notification.service');

const EMAIL_A = 'svctest-notif-a@example.com';
const EMAIL_B = 'svctest-notif-b@example.com';

let userA;
let userB;

beforeAll(async function() {
    await mongoose.connect(config.mongoUri);
});

afterAll(async function() {
    await mongoose.disconnect();
});

beforeEach(async function() {
    await User.deleteMany({ email: { $in: [EMAIL_A, EMAIL_B] } });
    userA = await User.create({ name: 'User A', email: EMAIL_A, password: 'plaintext123' });
    userB = await User.create({ name: 'User B', email: EMAIL_B, password: 'plaintext123' });
    await Notification.deleteMany({ userId: { $in: [userA._id, userB._id] } });
});

describe('getInbox', function() {
    it('returns the notification list AND unread count together', async function() {
        await Notification.create({ userId: userA._id, type: 'system', title: 'A', message: 'a' });
        await Notification.create({ userId: userA._id, type: 'system', title: 'B', message: 'b' });

        const inbox = await notificationService.getInbox(userA._id);

        expect(inbox.notifications).toHaveLength(2);
        expect(inbox.unreadCount).toBe(2);
    });
});

describe('markAsRead', function() {
    it('marks a notification read for its owner', async function() {
        const n = await Notification.create({ userId: userA._id, type: 'system', title: 'A', message: 'a' });

        const updated = await notificationService.markAsRead(n._id, userA._id);
        expect(updated.isRead).toBe(true);
    });

    it('throws a 404 when called by a different user', async function() {
        const n = await Notification.create({ userId: userA._id, type: 'system', title: 'A', message: 'a' });

        await expect(notificationService.markAsRead(n._id, userB._id)).rejects.toMatchObject({ statusCode: 404 });
    });

    it('throws a 404 when re-marking an already-read notification', async function() {
        const n = await Notification.create({ userId: userA._id, type: 'system', title: 'A', message: 'a' });
        await notificationService.markAsRead(n._id, userA._id);

        await expect(notificationService.markAsRead(n._id, userA._id)).rejects.toMatchObject({ statusCode: 404 });
    });
});

describe('markAllAsRead', function() {
    it('marks every unread notification for that user and reports the count', async function() {
        await Notification.create({ userId: userA._id, type: 'system', title: 'A', message: 'a' });
        await Notification.create({ userId: userA._id, type: 'system', title: 'B', message: 'b' });

        const result = await notificationService.markAllAsRead(userA._id);
        expect(result.modifiedCount).toBe(2);

        const inbox = await notificationService.getInbox(userA._id);
        expect(inbox.unreadCount).toBe(0);
    });
});