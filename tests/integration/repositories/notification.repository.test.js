// tests/integration/repositories/notification.repository.test.js
//
// Integration test for notification.repository.js. createForAlertTrigger
// is the purpose-built creation path used by alert.service.js's
// checkAndTriggerAlerts (File 44) - this locks its message formatting
// in permanently.
//
// notificationBus is mocked (real Redis/EventEmitter behavior is
// covered separately in tests/unit/realtime/notificationBus.test.js) so
// this file can assert the WIRING - every write path calls publish()
// and invalidates the cache - without needing a real subscriber. cache
// itself is left real: Redis is disabled in the test env, so cache.del
// is already a safe, fast no-op (src/utils/cache.js's own contract) -
// spying on it (not replacing it) lets these tests assert it was
// called with the right key while still exercising the real function.

'use strict';

jest.mock('../../../src/realtime/notificationBus');

const mongoose = require('mongoose');
const config = require('../../../src/config/env');
const User = require('../../../src/models/User.model');
const Notification = require('../../../src/models/Notification.model');
const notificationBus = require('../../../src/realtime/notificationBus');
const cache = require('../../../src/utils/cache');
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
    jest.clearAllMocks();
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

// ── Real-time push + cache invalidation ─────────────────────────────
//
// This is the wiring the "CRITICAL LOGIC" requirement (a notification
// must be pushed the moment it's created) actually depends on: every
// creation path here is the ONLY place notificationBus.publish() is
// ever called from, and every write path (create + both read-state
// mutations) must invalidate the cached inbox or a client would keep
// seeing stale data until the TTL expires.
describe('real-time push + cache invalidation', function() {
    it('create() publishes the created notification to notificationBus for the right user', async function() {
        const n = await notificationRepository.create(userA._id, 'system', 'Title', 'Message');

        expect(notificationBus.publish).toHaveBeenCalledTimes(1);
        const [publishedUserId, publishedNotification] = notificationBus.publish.mock.calls[0];
        expect(String(publishedUserId)).toBe(String(userA._id));
        expect(publishedNotification._id).toEqual(n._id);
    });

    it('createForAlertTrigger() also publishes - the OTHER real creation path (called directly by alert.service.js)', async function() {
        await notificationRepository.createForAlertTrigger(userA._id, userA._id, 'Product', 999);

        expect(notificationBus.publish).toHaveBeenCalledTimes(1);
        expect(String(notificationBus.publish.mock.calls[0][0])).toBe(String(userA._id));
    });

    it('create() invalidates the cached inbox for that user', async function() {
        const delSpy = jest.spyOn(cache, 'del');

        await notificationRepository.create(userA._id, 'system', 'Title', 'Message');

        expect(delSpy).toHaveBeenCalledWith('notifications:' + userA._id);
        delSpy.mockRestore();
    });

    it('markAsRead() invalidates the cache only when something actually changed', async function() {
        const n = await notificationRepository.create(userA._id, 'system', 'A', 'a');
        const delSpy = jest.spyOn(cache, 'del');

        await notificationRepository.markAsRead(n._id, userA._id);
        expect(delSpy).toHaveBeenCalledWith('notifications:' + userA._id);

        delSpy.mockClear();
        await notificationRepository.markAsRead(n._id, userA._id); // already read - no-op
        expect(delSpy).not.toHaveBeenCalled();

        delSpy.mockRestore();
    });

    it('markAllAsReadForUser() invalidates the cache only when at least one row changed', async function() {
        await notificationRepository.create(userA._id, 'system', 'A', 'a');
        const delSpy = jest.spyOn(cache, 'del');

        await notificationRepository.markAllAsReadForUser(userA._id);
        expect(delSpy).toHaveBeenCalledWith('notifications:' + userA._id);

        delSpy.mockClear();
        await notificationRepository.markAllAsReadForUser(userA._id); // nothing left unread
        expect(delSpy).not.toHaveBeenCalled();

        delSpy.mockRestore();
    });

    it('does not publish or invalidate the cache for a DIFFERENT user\'s notifications', async function() {
        await notificationRepository.create(userA._id, 'system', 'A', 'a');

        expect(notificationBus.publish).not.toHaveBeenCalledWith(String(userB._id), expect.anything());
    });
});