'use strict';

const request = require('supertest');
const { createServer } = require('../server');

const server = createServer();
afterAll(async () => {
  if (server.listening) await new Promise((resolve) => server.close(resolve));
});

test('serves the dashboard separately with a constrained API connection policy', async () => {
  const page = await request(server).get('/');
  expect(page.status).toBe(200);
  expect(page.headers['content-security-policy']).toMatch(/connect-src 'self' http:\/\/localhost:5005/);
  expect(page.text).toMatch(/\/config\.js/);
  expect(page.text).toMatch(/\/dashboard\.js/);

  const config = await request(server).get('/config.js');
  expect(config.status).toBe(200);
  expect(config.text).toMatch(/SECURITY_MONITOR_API_URL = "http:\/\/localhost:5005"/);

  const stylesheet = await request(server).get('/dashboard.css');
  expect(stylesheet.status).toBe(200);
  expect(stylesheet.headers['content-type']).toMatch(/text\/css/);

  const script = await request(server).get('/dashboard.js');
  expect(script.status).toBe(200);
  expect(script.text).toMatch(/credentials: 'include'/);
});

test('does not expose server source or files outside the public directory', async () => {
  const response = await request(createServer()).get('/server.js');
  expect(response.status).toBe(404);
  expect(response.text).not.toMatch(/loadConfig|createServer/);
});
