// tests/manual/test-alert-service.js
require('../../src/config/env');
const { connectDB, disconnectDB } = require('../../src/config/db');
const User = require('../../src/models/User.model');
const Product = require('../../src/models/Product.model');
const Alert = require('../../src/models/Alert.model');
const Notification = require('../../src/models/Notification.model');
const alertService = require('../../src/services/alert.service');
const ApiError = require('../../src/utils/ApiError');

async function run() {
    await connectDB();

    await User.deleteMany({ email: { $in: ['alertsvc1@example.com', 'alertsvc2@example.com'] } });
    await Product.deleteOne({ marketplace: 'amazon', externalId: 'ALERTSVCTEST123' });

    const userA = await User.create({ name: 'User A', email: 'alertsvc1@example.com', password: 'plaintext123' });
    const userB = await User.create({ name: 'User B', email: 'alertsvc2@example.com', password: 'plaintext123' });

    const product = await Product.create({
        marketplace: 'amazon',
        externalId: 'ALERTSVCTEST123',
        title: 'Alert Service Test Product',
        currentPrice: 50000,
        rawUrl: 'https://www.amazon.in/dp/ALERTSVCTEST123',
        fetchedVia: 'scraper',
    });

    await Alert.deleteMany({ userId: { $in: [userA._id, userB._id] } });
    await Notification.deleteMany({ userId: { $in: [userA._id, userB._id] } });

    // 1. createAlert - valid target below current price
    const alert1 = await alertService.createAlert(userA._id, product._id, 45000);
    console.log('Alert created (expect true):', !!alert1._id);

    // 2. createAlert - target ABOVE current price should throw 400
    try {
        await alertService.createAlert(userA._id, product._id, 60000);
        console.log('ERROR: target above current price was allowed');
    } catch (err) {
        console.log('Target above current price correctly rejected (expect true):', err.statusCode === 400);
        console.log('Error message:', err.message);
    }

    // 3. createAlert on nonexistent product
    try {
        await alertService.createAlert(userA._id, '000000000000000000000000', 1000);
        console.log('ERROR: nonexistent product was allowed');
    } catch (err) {
        console.log('Nonexistent product correctly rejected (expect true):', err.statusCode === 404);
    }

    // 4. Second alert with a lower target
    const alert2 = await alertService.createAlert(userA._id, product._id, 40000);

    // 5. Simulate price dropping to 44000 - checkAndTriggerAlerts
    const triggered = await alertService.checkAndTriggerAlerts(product._id, 44000, product.title);
    console.log('Alerts triggered (expect 1):', triggered.length);
    console.log('Triggered alert targetPrice (expect 45000):', triggered[0].targetPrice);

    const notifications = await Notification.find({ userId: userA._id });
    console.log('Notification created for trigger (expect 1):', notifications.length);
    console.log('Notification message:', notifications[0].message);

    // 6. Running the SAME check again should NOT re-trigger (idempotent)
    const triggeredAgain = await alertService.checkAndTriggerAlerts(product._id, 44000, product.title);
    console.log('No re-trigger on repeat check (expect 0):', triggeredAgain.length);
    const notificationsAfter = await Notification.find({ userId: userA._id });
    console.log('Still only 1 notification, not duplicated (expect 1):', notificationsAfter.length);

    // 7. Ownership - userB cannot cancel userA's remaining alert
    try {
        await alertService.cancelAlert(alert2._id, userB._id);
        console.log('ERROR: cross-user cancel was allowed');
    } catch (err) {
        console.log('Cross-user cancel correctly rejected (expect true):', err.statusCode === 404);
    }

    // 8. Correct owner CAN cancel
    const cancelled = await alertService.cancelAlert(alert2._id, userA._id);
    console.log('Alert cancelled (expect cancelled):', cancelled.status);

    // Cleanup
    await Alert.deleteMany({ userId: { $in: [userA._id, userB._id] } });
    await Notification.deleteMany({ userId: { $in: [userA._id, userB._id] } });
    await Product.deleteOne({ _id: product._id });
    await User.deleteMany({ _id: { $in: [userA._id, userB._id] } });

    await disconnectDB();
    process.exit(0);
}

run().catch(function(err) {
    console.error('Test script failed:', err);
    process.exit(1);
});