'use strict';

module.exports = {
  rootDir: __dirname,
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/backend/tests/**/*.test.js',
    '<rootDir>/frontend/tests/**/*.test.js',
  ],
  testTimeout: 30000,
  forceExit: true,
  verbose: true,
};
