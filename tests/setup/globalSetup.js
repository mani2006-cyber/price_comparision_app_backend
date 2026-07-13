// tests/setup/globalSetup.js
//
// Runs ONCE before any test file loads. Verifies we're pointed at a
// TEST database (hard safety check - refuses to proceed otherwise) and
// wipes it clean before the suite starts. Runs in a SEPARATE process
// from test files (Jest's globalSetup contract) - does not share a
// connection with them; each test file manages its own connect/disconnect.

'use strict';

module.exports = async function globalSetup() {
    process.env.NODE_ENV = 'test';

    // Fresh require here (separate process from test files) is
    // intentional, not a mistake to "optimize away".
    const config = require('../../src/config/env');
    const mongoose = require('mongoose');

    // The hard safety check: refuse to touch ANYTHING unless the
    // database name unambiguously contains "test". Given how much manual
    // testing in this project ran directly against the real dev database,
    // an automated suite that WIPES collections needs a guardrail with
    // real teeth, not just a naming convention we hope gets followed.
    if (config.mongoUri.toLowerCase().indexOf('test') === -1) {
        throw new Error(
            'Refusing to run tests: MONGO_URI does not contain "test" (' + config.mongoUri + '). ' +
            'This safety check exists to prevent the test suite from ever wiping a real database. ' +
            'Check .env.test.'
        );
    }

    await mongoose.connect(config.mongoUri);
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();

    console.log('[globalSetup] Test database verified and cleared:', config.mongoUri);
};