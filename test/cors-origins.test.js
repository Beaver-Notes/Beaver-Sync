'use strict';
process.env.NODE_ENV = 'test';
process.env.COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars-long';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-chars-long';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { setupTestDb, cleanTestDb } = require('./helpers/db');
const { buildApp } = require('../src/server');
const { buildCorsOrigin } = require('../src/lib/cors-origins');

before(setupTestDb);
after(cleanTestDb);

test('the production CORS list contains every Tauri WebView origin including schemes', () => {
  const list = buildCorsOrigin({ nodeEnv: 'production', allowedOrigins: 'https://app.example.com' });
  assert.deepEqual(list, [
    'https://app.example.com',
    'tauri://localhost',
    // Android and Windows Tauri send schemeful WebView origins; a schemeless
    // `tauri.localhost` entry can never match either.
    'http://tauri.localhost',
    'https://tauri.localhost',
  ]);
});

test('the dev origin pattern accepts local Tauri and web origins but no remote host', () => {
  const pattern = buildCorsOrigin({ nodeEnv: 'development', allowedOrigins: '' });
  assert.ok(pattern.test('http://localhost:5173'));
  assert.ok(pattern.test('tauri://localhost'));
  assert.ok(pattern.test('https://tauri.localhost'));
  assert.ok(!pattern.test('https://app.example.com'));
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
