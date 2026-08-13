// tests/integration/models/Notification.test.js
//
// Integration test for Notification.model.js. Covers unread-count
// queries and the isRead/readAt transition - the two things any
// notification inbox UI needs (File 15).

'use strict';

const mongoose = require('mongoose');
const config = require('../../../src/config/env');
const User = require('../../../src/models/User.model');
const Notification = require('../../../src/models/Notification.model');

const TEST_EMAIL = 'modeltest-notification@example.com';

let user;

beforeAll(async function() {
    await mongoose.connect(config.mongoUri);
});

afterAll(async function() {
    await mongoose.disconnect();
});

beforeEach(async function() {
    await User.deleteMany({ email: TEST_EMAIL });
    user = await User.create({ name: 'Notification Test', email: TEST_EMAIL, password: 'plaintext123' });
    await Notification.deleteMany({ userId: user._id });
});

describe('Notification model', function() {
    it('defaults isRead to false and readAt to null on creation', async function() {
        const n = await Notification.create({
            userId: user._id,
            type: 'price_drop',
            title: 'Price dropped!',
            message: 'Test product dropped to ₹2799',
        });

        expect(n.isRead).toBe(false);
        expect(n.readAt).toBeNull();
    });

    it('counts unread notifications correctly, and again after marking one read', async function() {
        const n1 = await Notification.create({ userId: user._id, type: 'price_drop', title: 'A', message: 'a' });
        await Notification.create({ userId: user._id, type: 'system', title: 'B', message: 'b' });

        expect(await Notification.countDocuments({ userId: user._id, isRead: false })).toBe(2);

        n1.isRead = true;
        n1.readAt = new Date();
        await n1.save();

        expect(await Notification.countDocuments({ userId: user._id, isRead: false })).toBe(1);
    });

    it('stores an arbitrary data payload for frontend deep-linking', async function() {
        const n = await Notification.create({
            userId: user._id,
            type: 'price_drop',
            title: 'Price dropped!',
            message: 'msg',
            data: { productId: 'abc123', price: 2799 },
        });

        expect(n.data.productId).toBe('abc123');
        expect(n.data.price).toBe(2799);
    });

    it('lists notifications newest-first', async function() {
        await Notification.create({ userId: user._id, type: 'system', title: 'First', message: 'a' });
        await Notification.create({ userId: user._id, type: 'system', title: 'Second', message: 'b' });

        const list = await Notification.find({ userId: user._id }).sort({ createdAt: -1 });
        expect(list[0].title).toBe('Second');
    });
});