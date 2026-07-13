// jest.config.js
//
// Jest configuration. testEnvironment is explicitly 'node' (never
// jsdom - this is a backend, not a browser). globalSetup verifies we're
// pointed at a TEST database before any test runs - a dedicated safety
// check given how much of this project's manual testing has run
// directly against the real dev database, which automated tests must
// never touch.

'use strict';

module.exports = {
    testEnvironment: 'node',
    testMatch: [
        '<rootDir>/tests/unit/**/*.test.js',
        '<rootDir>/tests/integration/**/*.test.js',
    ],
    globalSetup: '<rootDir>/tests/setup/globalSetup.js',
    globalTeardown: '<rootDir>/tests/setup/globalTeardown.js',
    testTimeout: 30000,
    // Some resources (cron schedules, open DB handles) can keep the
    // process alive after tests finish even when everything is closed
    // correctly - this is a documented, common pattern for this kind of
    // app, not a leak to chase.
    forceExit: true,
    verbose: true,
};