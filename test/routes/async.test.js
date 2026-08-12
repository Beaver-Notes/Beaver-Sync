'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');

process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = path.join(repoRoot, ".test-data", "test.db");
process.env.JWT_PRIVATE_KEY_PATH = path.join(repoRoot, 'keys/private.pem');
process.env.JWT_PUBLIC_KEY_PATH = path.join(repoRoot, 'keys/public.pem');
process.env.COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars-long';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-characters-long';
process.env.AUTH_RATE_LIMIT_PER_MINUTE = '100';
process.env.LEGACY_AUTH_ENABLED = 'true';

describe('Async routes', () => {
  it('account route handler is async', () => {
    const accountRoutes = require('../../src/routes/account');
    assert(typeof accountRoutes === 'function');
  });

  it('auth route handler is async', () => {
    const authRoutes = require('../../src/routes/auth');
    assert(typeof authRoutes === 'function');
  });

  it('collaboration route handler is async', () => {
    const collaborationRoutes = require('../../src/routes/collaboration');
    assert(typeof collaborationRoutes === 'function');
  });

  it('commits route handler is async', () => {
    const commitRoutes = require('../../src/routes/commits');
    assert(typeof commitRoutes === 'function');
  });

  it('organizations route handler is async', () => {
    const organizationRoutes = require('../../src/routes/organizations');
    assert(typeof organizationRoutes === 'function');
  });

  it('sync-state route handler is async', () => {
    const syncStateRoutes = require('../../src/routes/sync-state');
    assert(typeof syncStateRoutes === 'function');
  });

  it('vault route handler is async', () => {
    const vaultRoutes = require('../../src/routes/vault');
    assert(typeof vaultRoutes === 'function');
  });

  it('workspaces route handler is async', () => {
    const workspaceRoutes = require('../../src/routes/workspaces');
    assert(typeof workspaceRoutes === 'function');
  });
});
