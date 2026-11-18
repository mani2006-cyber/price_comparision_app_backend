'use strict';

jest.mock('mongoose', () => {
    const EventEmitter = require('events');
    const connection = new EventEmitter();
    connection.name = 'test-database';
    connection.readyState = 0;
    return { connection, connect: jest.fn().mockResolvedValue(undefined) };
});

jest.mock('ioredis', () => {
    const EventEmitter = require('events');
    return class FakeRedis extends EventEmitter {
        constructor() {
            super();
            this.status = 'connecting';
        }
    };
});

jest.mock('../../../src/config/env', () => ({
    mongoUri: 'mongodb://localhost/test',
    redis: { enabled: true, url: 'redis://localhost', keyPrefix: 'test:' },
}));
jest.mock('../../../src/utils/logger', () => ({
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
}));
jest.mock('../../../src/security/securityMonitorAgent', () => ({
    reportDependencyState: jest.fn(),
}));

const mongoose = require('mongoose');
const securityMonitorAgent = require('../../../src/security/securityMonitorAgent');
const database = require('../../../src/config/db');
const redis = require('../../../src/config/redis');

beforeEach(() => {
    securityMonitorAgent.reportDependencyState.mockClear();
});

test('reports MongoDB outage and recovery once per state transition', async () => {
    await database.connectDB();
    mongoose.connection.emit('error', { code: 'ECONNRESET' });
    mongoose.connection.emit('error', { code: 'ECONNRESET' });
    mongoose.connection.emit('disconnected');
    mongoose.connection.emit('reconnected');
    mongoose.connection.emit('reconnected');

    expect(securityMonitorAgent.reportDependencyState).toHaveBeenNthCalledWith(1, 'mongodb', 'down', 'ECONNRESET');
    expect(securityMonitorAgent.reportDependencyState).toHaveBeenNthCalledWith(2, 'mongodb', 'recovered');
    expect(securityMonitorAgent.reportDependencyState).toHaveBeenCalledTimes(2);
});

test('reports Redis outage and recovery once per state transition', () => {
    redis.client.emit('error', { code: 'ECONNREFUSED', message: 'connection refused' });
    redis.client.emit('error', { code: 'ECONNREFUSED', message: 'connection refused' });
    redis.client.emit('ready');
    redis.client.emit('ready');

    expect(securityMonitorAgent.reportDependencyState).toHaveBeenNthCalledWith(1, 'redis', 'down', 'ECONNREFUSED');
    expect(securityMonitorAgent.reportDependencyState).toHaveBeenNthCalledWith(2, 'redis', 'recovered');
    expect(securityMonitorAgent.reportDependencyState).toHaveBeenCalledTimes(2);
});
