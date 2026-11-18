'use strict';

jest.mock('../src/config/mysql', () => ({ query: jest.fn() }));

const db = require('../src/config/mysql');
const eventsRepo = require('../src/repositories/events.repo');

beforeEach(() => {
  db.query.mockReset();
});

test('search term matches every visible security event column, including displayed time', async () => {
  db.query.mockResolvedValueOnce([{ total: 0 }]).mockResolvedValueOnce([]);

  await eventsRepo.search({ q: '18/11/2026' });

  const [query, params] = db.query.mock.calls[0];
  expect(query).toContain("DATE_FORMAT(created_at, '%d/%m/%Y, %H:%i:%s') LIKE ?");
  expect(query).toContain('CAST(created_at AS CHAR) LIKE ?');
  expect(query).toContain("COALESCE(ip, '') LIKE ?");
  expect(query).toContain('event_type LIKE ?');
  expect(query).toContain('severity LIKE ?');
  expect(query).toContain("COALESCE(endpoint, '') LIKE ?");
  expect(query).toContain('description LIKE ?');
  expect(query).toContain('action LIKE ?');
  expect(params).toEqual(Array(8).fill('%18/11/2026%'));
});

test('escapes SQL LIKE wildcards in the event search term', async () => {
  db.query.mockResolvedValueOnce([{ total: 0 }]).mockResolvedValueOnce([]);

  await eventsRepo.search({ q: '%_\\\\' });

  const [, params] = db.query.mock.calls[0];
  expect(params[0]).toBe('%\\%\\_\\\\\\\\%');
});
