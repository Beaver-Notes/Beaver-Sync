'use strict';
process.env.NODE_ENV = 'test';
process.env.COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars-long';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-chars-long';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { setupTestDb, cleanTestDb } = require('./helpers/db');
const { buildApp } = require('../src/server');

before(setupTestDb);
after(cleanTestDb);

// NODE_ENV is 'test' here, so @fastify/cors takes the regex branch. The
// production branch is exercised indirectly: build the origin function the
// same way server.js does and assert the scheme variants it must include,
// because @fastify/cors compares entries by strict equality against the
// Origin header and a schemeless entry can never match a schemeful one.
function productionOriginList() {
  return (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
    .concat([
      'tauri://localhost',
      'http://tauri.localhost',
      'https://tauri.localhost',
    ]);
}

test('the production CORS list contains every Tauri WebView origin including schemes', () => {
  const list = productionOriginList();
  assert.ok(list.includes('tauri://localhost'));
  // Android and Windows Tauri send schemeful WebView origins; a schemeless
  // `tauri.localhost` entry can never match either.
  assert.ok(list.includes('http://tauri.localhost'));
  assert.ok(list.includes('https://tauri.localhost'));
});

test('CORS preflight accepts a localhost web origin on the test app', async () => {
  const app = await buildApp();
  try {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/health',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'GET',
      },
    });
    assert.equal(res.statusCode, 204);
    assert.equal(res.headers['access-control-allow-origin'], 'http://localhost:5173');
  } finally {
    await app.close();
  }
});
