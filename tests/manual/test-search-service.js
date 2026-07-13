// tests/manual/test-price-refresher.js
require('../../src/config/env');
const { connectDB, disconnectDB } = require('../../src/config/db');
const Product = require('../../src/models/Product.model');
const priceRefresherJob = require('../../src/jobs/priceRefresher.job');

async function run() {
    await connectDB();

    // Force at least one real product to look "stale" by backdating its
    // lastCheckedAt, so this run has something genuine to refresh -
    // otherwise a freshly-searched catalog might have nothing due for a
    // check yet, and the test wouldn't prove anything.
    const anyProduct = await Product.findOne({ marketplace: { $in: ['amazon', 'flipkart'] } });

    if (!anyProduct) {
        console.log('No existing product found - run a search first (e.g. via test-product-service.js) so there is real data to refresh.');
        process.exit(1);
    }

    await Product.updateOne({ _id: anyProduct._id }, { lastCheckedAt: new Date(Date.now() - 7 * 60 * 60 * 1000) } // 7 hours ago - past the 6hr staleness threshold
    );

    console.log('Backdated product for testing:', anyProduct.title.slice(0, 50));
    console.log('Running priceRefresherJob.runOnce()... this may take a moment\n');

    const result = await priceRefresherJob.runOnce();

    console.log('\nRun result:', result);
    console.log('Total >= 1 (expect true):', result.total >= 1);
    console.log('succeeded + failed === total (expect true):', (result.succeeded + result.failed) === result.total);

    // Confirm lastCheckedAt actually advanced past our backdated value
    const afterRefresh = await Product.findById(anyProduct._id);
    console.log('lastCheckedAt updated to a recent time (expect true):', afterRefresh.lastCheckedAt > new Date(Date.now() - 60000));

    await disconnectDB();
    process.exit(0);
}

run().catch(function(err) {
    console.error('Test script failed:', err);
    process.exit(1);
});