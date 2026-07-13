// tests/manual/test-notification-model.js
require('../../src/config/env');
const { connectDB, disconnectDB } = require('../../src/config/db');
const User = require('../../src/models/User.model');
const Notification = require('../../src/models/Notification.model');

async function run() {
    await connectDB();

    await User.deleteOne({ email: 'notiftest@example.com' });

    const user = await User.create({
        name: 'Notification Test',
        email: 'notiftest@example.com',
        password: 'plaintext123',
    });

    await Notification.deleteMany({ userId: user._id });

    // 1. Create a price-drop notification (as an Alert-firing would produce)
    const n1 = await Notification.create({
        userId: user._id,
        type: 'price_drop',
        title: 'Price dropped!',
        message: 'Test Wireless Headphones dropped to ₹2799',
        data: { price: 2799 },
    });
    console.log('Notification created, isRead defaults to false (expect false):', n1.isRead);

    // 2. Create a second, unrelated notification
    await Notification.create({
        userId: user._id,
        type: 'system',
        title: 'Welcome',
        message: 'Thanks for signing up',
    });

    // 3. Unread count query
    const unreadCount = await Notification.countDocuments({ userId: user._id, isRead: false });
    console.log('Unread count (expect 2):', unreadCount);

    // 4. Mark one as read
    n1.isRead = true;
    n1.readAt = new Date();
    await n1.save();

    const unreadAfter = await Notification.countDocuments({ userId: user._id, isRead: false });
    console.log('Unread count after marking one read (expect 1):', unreadAfter);

    // 5. Newest-first listing
    const list = await Notification.find({ userId: user._id }).sort({ createdAt: -1 });
    console.log('Most recent notification title (expect Welcome):', list[0].title);

    await Notification.deleteMany({ userId: user._id });
    await User.deleteOne({ _id: user._id });

    await disconnectDB();
    process.exit(0);
}

run().catch(function(err) {
    console.error('Test script failed:', err);
    process.exit(1);
});