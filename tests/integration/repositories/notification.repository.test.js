// tests/integration/repositories/notification.repository.test.js
//
// Integration test for notification.repository.js. createForAlertTrigger
// is the purpose-built creation path used by alert.service.js's
// checkAndTriggerAlerts (File 44) - this locks its message formatting
// in permanently.

'use strict';

const mongoose = require('mongoose');
const config = require('../../../src/config/env');
const User = require('../../../src/models/User.model');
const Notification = require('../../../src/models/Notification.model');
const notificationRepository = require('../../../src/repositories/notification.repository');

const EMAIL_A = 'repotest-notif-a@example.com';
const EMAIL_B = 'repotest-notif-b@example.com';

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

describe('createForAlertTrigger', function() {
    it('builds a consistent title/message/data shape', async function() {
        const fakeAlertId = userA._id; // any valid ObjectId shape works here

        const n = await notificationRepository.createForAlertTrigger(userA._id, fakeAlertId, 'Test Headphones', 2799);

        expect(n.type).toBe('price_drop');
        expect(n.message).toBe('Test Headphones dropped to ₹2799');
        expect(n.data.price).toBe(2799);
    });
});

describe('getUnreadCount', function() {
    it('counts unread notifications and updates after marking one read', async function() {
        const n1 = await notificationRepository.create(userA._id, 'system', 'A', 'a');
        await notificationRepository.create(userA._id, 'system', 'B', 'b');

        expect(await notificationRepository.getUnreadCount(userA._id)).toBe(2);

        await notificationRepository.markAsRead(n1._id, userA._id);
        expect(await notificationRepository.getUnreadCount(userA._id)).toBe(1);
    });
});

describe('markAsRead - ownership scoping', function() {
    it('does NOT mark as read when called by a different user', async function() {
        const n = await notificationRepository.create(userA._id, 'system', 'A', 'a');

        const result = await notificationRepository.markAsRead(n._id, userB._id);
        expect(result).toBeNull();
    });

    it('DOES mark as read when called by the actual owner', async function() {
        const n = await notificationRepository.create(userA._id, 'system', 'A', 'a');

        const result = await notificationRepository.markAsRead(n._id, userA._id);
        expect(result.isRead).toBe(true);
    });
});

describe('markAllAsReadForUser', function() {
    it('marks every unread notification for that user, returns the modified count', async function() {
        await notificationRepository.create(userA._id, 'system', 'A', 'a');
        await notificationRepository.create(userA._id, 'system', 'B', 'b');
        await notificationRepository.create(userB._id, 'system', 'C', 'c'); // different user - unaffected

        const modifiedCount = await notificationRepository.markAllAsReadForUser(userA._id);
        expect(modifiedCount).toBe(2);

        expect(await notificationRepository.getUnreadCount(userA._id)).toBe(0);
        expect(await notificationRepository.getUnreadCount(userB._id)).toBe(1); // untouched
    });
});