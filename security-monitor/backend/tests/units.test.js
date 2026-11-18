'use strict';
process.env.JWT_SECRET = 'a'.repeat(40);
process.env.SERVICE_HMAC_SECRET = 'b'.repeat(40);
process.env.FRONTEND_ORIGIN = 'http://localhost:5174';
const request = require('supertest');
const { createApp } = require('../src/app');
const { normalizePath } = require('../src/utils/endpointNormalizer');
const { normalizeIp, isAllowlisted } = require('../src/utils/ip');
const { sign, sha256 } = require('../src/middleware/verifyServiceSignature');

test('allows the separate frontend origin for credentialed API requests', async () => {
  const response = await request(createApp())
    .options('/api/auth/login')
    .set('Origin', 'http://localhost:5174')
    .set('Access-Control-Request-Method', 'POST')
    .set('Access-Control-Request-Headers', 'content-type,x-requested-with');
  expect(response.status).toBe(204);
  expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5174');
  expect(response.headers['access-control-allow-credentials']).toBe('true');

  const page = await request(createApp()).get('/');
  expect(page.status).toBe(404);
});

test('normalizePath collapses ObjectIds and trailing slashes', () => {
  expect(normalizePath('/api/products/6afc39451a29478e01ee84cf/')).toBe('/api/products/:id');
});
test('loopback and private IPs are allowlisted, public are not', () => {
  expect(isAllowlisted(normalizeIp('::ffff:127.0.0.1'), ['127.0.0.0/8', '10.0.0.0/8'])).toBe(true);
  expect(isAllowlisted('203.0.113.5', ['127.0.0.0/8', '10.0.0.0/8'])).toBe(false);
});
test('signature depends on body hash', () => {
  const a = sign('s'.repeat(40), '1', 'n', 'POST', '/internal/events', sha256(Buffer.from('a')));
  const b = sign('s'.repeat(40), '1', 'n', 'POST', '/internal/events', sha256(Buffer.from('b')));
  expect(a).not.toBe(b);
});
