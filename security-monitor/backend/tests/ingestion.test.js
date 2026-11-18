'use strict';

jest.mock('../src/config/redis', () => ({
  redis: {
    pipeline: () => {
      const commands = [];
      return {
        set() { commands.push('set'); return this; },
        exec: async () => commands.map(() => [null, 'OK']),
      };
    },
    del: jest.fn().mockResolvedValue(1),
  },
}));
jest.mock('../src/repositories/accessLogs.repo', () => ({ bulkInsert: jest.fn() }));
jest.mock('../src/services/settings.service', () => ({ getDetection: jest.fn().mockResolvedValue({}) }));
jest.mock('../src/services/stats.service', () => ({
  createAccumulator: () => ({ add: jest.fn(), flush: jest.fn().mockResolvedValue(undefined) }),
}));
jest.mock('../src/services/ruleEngine', () => ({ run: jest.fn().mockResolvedValue({ suspicious: false }) }));
jest.mock('../src/services/records.service', () => ({ recordEvent: jest.fn().mockResolvedValue({}) }));
jest.mock('../src/realtime/broadcaster', () => ({ queueTraffic: jest.fn() }));
jest.mock('../src/utils/logger', () => ({ error: jest.fn() }));

const ingestion = require('../src/services/ingestion.service');
const recordsService = require('../src/services/records.service');
const ruleEngine = require('../src/services/ruleEngine');

test('persists sanitized application and dependency events without invoking traffic rules', async () => {
  const result = await ingestion.ingest([
    {
      type: 'app_error',
      eventId: 'application-error-1',
      ip: '203.0.113.15',
      method: 'GET',
      path: '/api/products/:id',
      status: 503,
      requestId: 'request-123',
      errorCode: 'ECONNRESET',
      stack: 'must-not-be-persisted',
    },
    {
      type: 'outbound_failure',
      eventId: 'outbound-failure-1',
      destinationHost: 'marketplace.example.test',
      method: 'GET',
      status: 503,
      durationMs: 120.5,
      errorCode: 'ERR_BAD_RESPONSE',
      url: 'https://marketplace.example.test/item?api_key=private',
    },
    {
      type: 'dependency',
      eventId: 'dependency-down-1',
      dependency: 'redis',
      state: 'down',
      errorCode: 'ECONNREFUSED',
    },
  ]);

  expect(result).toMatchObject({ accepted: 3, duplicates: 0, rejected: 0 });
  expect(recordsService.recordEvent).toHaveBeenCalledTimes(3);
  expect(recordsService.recordEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({
    eventType: 'APPLICATION_ERROR',
    severity: 'HIGH',
    ip: '203.0.113.15',
    endpoint: '/api/products/:id',
    meta: expect.objectContaining({ source: 'price-comparison-api', errorCode: 'ECONNRESET' }),
  }));
  expect(recordsService.recordEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({
    eventType: 'OUTBOUND_HTTP_FAILURE',
    severity: 'HIGH',
    ip: null,
    description: expect.stringContaining('marketplace.example.test'),
    meta: expect.objectContaining({ destinationHost: 'marketplace.example.test', durationMs: 121 }),
  }));
  expect(recordsService.recordEvent).toHaveBeenNthCalledWith(3, expect.objectContaining({
    eventType: 'DEPENDENCY_DOWN',
    severity: 'HIGH',
    ip: null,
    meta: expect.objectContaining({ dependency: 'redis', state: 'down' }),
  }));
  expect(JSON.stringify(recordsService.recordEvent.mock.calls)).not.toContain('must-not-be-persisted');
  expect(JSON.stringify(recordsService.recordEvent.mock.calls)).not.toContain('api_key=private');
  expect(ruleEngine.run).not.toHaveBeenCalled();
});
