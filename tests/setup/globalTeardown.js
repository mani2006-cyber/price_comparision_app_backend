// tests/setup/globalTeardown.js
//
// Runs ONCE after every test file has finished. Wipes the test database
// again so repeated `npm test` runs over time don't accumulate cruft.
// Same safety check as globalSetup - never skip it just because setup
// already checked once; this runs in a separate invocation.

'use strict';

module.exports = async function globalTeardown() {
    const config = require('../../src/config/env');
    const mongoose = require('mongoose');

    if (config.mongoUri.toLowerCase().indexOf('test') === -1) {
        console.error('[globalTeardown] Refusing to drop a non-test database:', config.mongoUri);
        return;
    }

    await mongoose.connect(config.mongoUri);
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();

    console.log('[globalTeardown] Test database cleared');
};