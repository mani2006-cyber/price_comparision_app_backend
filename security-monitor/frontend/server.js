'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const publicDir = path.join(__dirname, 'public');
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function loadEnvFile() {
  let contents;
  try {
    contents = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }

  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, '$2');
    process.env[match[1]] = value;
  }
}

function loadConfig() {
  loadEnvFile();
  const apiUrl = new URL(process.env.API_URL || 'http://localhost:5005');
  if (!['http:', 'https:'].includes(apiUrl.protocol) || apiUrl.username || apiUrl.password
      || (apiUrl.pathname !== '/' && apiUrl.pathname !== '') || apiUrl.search || apiUrl.hash) {
    throw new Error('API_URL must be an HTTP(S) origin without credentials, path, query, or fragment');
  }

  const port = Number(process.env.PORT || 5174);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');

  return {
    apiOrigin: apiUrl.origin,
    apiUrl: apiUrl.origin,
    host: process.env.HOST || 'localhost',
    port,
  };
}

function createServer(config = loadConfig()) {
  const contentSecurityPolicy = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    `connect-src 'self' ${config.apiOrigin}`,
    "img-src 'self' data:",
    "font-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
  const headers = {
    'Content-Security-Policy': contentSecurityPolicy,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  };

  return http.createServer((request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { ...headers, Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Method not allowed');
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    } catch {
      response.writeHead(400, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Invalid request path');
      return;
    }

    if (pathname === '/config.js') {
      const body = `window.SECURITY_MONITOR_API_URL = ${JSON.stringify(config.apiUrl)};\n`;
      response.writeHead(200, { ...headers, 'Content-Type': 'text/javascript; charset=utf-8' });
      response.end(request.method === 'HEAD' ? undefined : body);
      return;
    }

    const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const filePath = path.resolve(publicDir, relativePath);
    if (!filePath.startsWith(`${publicDir}${path.sep}`)) {
      response.writeHead(404, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }

    fs.readFile(filePath, (error, body) => {
      if (error) {
        if (error.code !== 'ENOENT' && error.code !== 'EISDIR') console.error('Frontend asset read failed:', error.message);
        response.writeHead(error.code === 'ENOENT' || error.code === 'EISDIR' ? 404 : 500,
          { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
        response.end(error.code === 'ENOENT' || error.code === 'EISDIR' ? 'Not found' : 'Unable to read frontend asset');
        return;
      }

      const contentType = mimeTypes[path.extname(filePath).toLowerCase()];
      if (!contentType) {
        response.writeHead(404, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Not found');
        return;
      }
      response.writeHead(200, { ...headers, 'Content-Type': contentType });
      response.end(request.method === 'HEAD' ? undefined : body);
    });
  });
}

if (require.main === module) {
  const config = loadConfig();
  const server = createServer(config);
  server.listen(config.port, config.host, () => {
    console.log(`Security Monitor frontend at http://${config.host}:${config.port} (API: ${config.apiUrl})`);
  });
}

module.exports = { createServer, loadConfig };
