'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');

process.env.NODE_ENV = 'test';
process.env.JWT_PRIVATE_KEY_PATH = path.join(repoRoot, 'keys/private.pem');
process.env.JWT_PUBLIC_KEY_PATH = path.join(repoRoot, 'keys/public.pem');
process.env.COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars-long';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-characters-long';
process.env.AUTH_RATE_LIMIT_PER_MINUTE = '100';
process.env.LEGACY_AUTH_ENABLED = 'true';

const { close } = require('../../src/db');
const { setupTestDb, cleanTestDb } = require('../helpers/db');

describe('WebSocket routes', () => {
  before(async () => {
    await setupTestDb();
    await cleanTestDb();
  });

  after(() => {
    close();
  });
  it('ws.js module exports a function', () => {
    const wsRoutes = require('../../src/routes/ws');
    assert(typeof wsRoutes === 'function');
  });

  it('events.js module exports expected functions', () => {
    const events = require('../../src/lib/events');
    assert(typeof events.subscribe === 'function');
    assert(typeof events.publish === 'function');
    assert(typeof events.notify === 'function');
    assert(typeof events.startPostgresListener === 'function');
  });

  it('events subscribe and publish work locally', (_, done) => {
    const { subscribe, publish } = require('../../src/lib/events');
    const channel = 'test:local:' + Date.now();

    const unsub = subscribe(channel, (data) => {
      assert.deepStrictEqual(data, { hello: 'world' });
      unsub();
      done();
    });

    publish(channel, { hello: 'world' });
  });

  it('events subscribe returns unsubscribe function', () => {
    const { subscribe } = require('../../src/lib/events');
    const channel = 'test:unsub:' + Date.now();
    let called = false;

    const unsub = subscribe(channel, () => { called = true; });
    unsub();

    const { publish } = require('../../src/lib/events');
    publish(channel, {});
    assert.strictEqual(called, false);
  });
});
