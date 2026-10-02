'use strict';

// verify-session and verify-ticket resolve a bearer token to an identity, so an
// unset INTERNAL_API_SECRET must close them rather than open them. In production
// src/server.js:39 exits at boot without it, which is why this was a staging-only
// hole; it is now closed at the handler as well.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
process.env.NODE_ENV = 'test';
process.env.JWT_PRIVATE_KEY_PATH = path.join(repoRoot, 'keys/private.pem');
process.env.JWT_PUBLIC_KEY_PATH = path.join(repoRoot, 'keys/public.pem');
process.env.COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars-long';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-characters-long';

const { close } = require('../src/db');
const { setupTestDb } = require('./helpers/db');
const { buildApp } = require('../src/server');

test.before(async () => { await setupTestDb(); });
test.after(async () => { await close(); });

for (const [name, url] of [['verify-session', '/auth/verify-session'], ['verify-ticket', '/auth/verify-ticket']]) {
  test(`${name} returns 503 rather than resolving identity when INTERNAL_API_SECRET is unset`, async (t) => {
    const app = await buildApp();
    t.after(async () => { await app.close(); });

    // buildApp dotenv-loads the dev .env; both gates read the env at request time.
    const previous = process.env.INTERNAL_API_SECRET;
    delete process.env.INTERNAL_API_SECRET;
    t.after(() => {
      if (previous === undefined) delete process.env.INTERNAL_API_SECRET;
      else process.env.INTERNAL_API_SECRET = previous;
    });

    const response = await app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json' },
      payload: {},
    });

    assert.equal(
      response.statusCode, 503,
      `an unset internal secret must close ${name}; the endpoint resolves any bearer token to a userId and role, so fail-open hands out a token-validity oracle`);
  });
}
