'use strict';

const path = require('path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..', '..');

// Dedicated Postgres test database, separate from local dev data.
const DEFAULT_DATABASE_URL = 'postgresql://beaver:beaver@localhost:5432/beaver_test';

function resolveTestDatabaseUrl() {
  const url = process.env.TEST_DATABASE_URL || DEFAULT_DATABASE_URL;
  const dbName = new URL(url).pathname.replace(/^\//, '');
  if (!dbName.endsWith('_test')) {
    throw new Error(
      `Refusing to run the test suite against ${url}: database name must end in "_test" ` +
      `(got "${dbName}"). Point TEST_DATABASE_URL at a dedicated test database.`
    );
  }
  return url;
}

// Own the test database URL unconditionally, so an exported DATABASE_URL from
// a real dev/prod environment can never make the suite DELETE its data.
process.env.DATABASE_URL = resolveTestDatabaseUrl();

// Own the storage endpoint: dev .env points MinIO at docker-internal hostnames
// that never resolve for host-run tests. Module scope, before services/r2 loads.
process.env.STORAGE_ENDPOINT = 'http://localhost:9000';
delete process.env.STORAGE_PUBLIC_ENDPOINT;

async function setupTestDb() {
  process.env.DATABASE_URL = resolveTestDatabaseUrl();

  process.env.NODE_ENV = process.env.NODE_ENV || 'test';
  // Dev .env values must never leak into the suite: PLAN_OVERRIDE would bypass
  // plan gates, and INTERNAL_API_SECRET would gate the relay auth endpoints
  // (verify-session/verify-ticket) behind a header the in-process tests don't send.
  delete process.env.PLAN_OVERRIDE;
  delete process.env.INTERNAL_API_SECRET;
  process.env.SESSION_HMAC_KEY = process.env.SESSION_HMAC_KEY || 'test-session-hmac-key-at-least-32-characters-long';
  process.env.EMAIL_HMAC_KEY = process.env.EMAIL_HMAC_KEY || 'test-email-hmac-key-at-least-32-characters-long';
  process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test-cookie-secret-at-least-32-chars-long';
  process.env.NOTE_HMAC_KEY = process.env.NOTE_HMAC_KEY || 'test-note-hmac-key-at-least-32-characters-long';

  if (!process.env.JWT_PRIVATE_KEY_PATH) {
    process.env.JWT_PRIVATE_KEY_PATH = path.join(repoRoot, 'keys/private.pem');
  }
  if (!process.env.JWT_PUBLIC_KEY_PATH) {
    process.env.JWT_PUBLIC_KEY_PATH = path.join(repoRoot, 'keys/public.pem');
  }
  if (!process.env.WEBAUTHN_RPID) {
    process.env.WEBAUTHN_RPID = 'localhost';
  }
  if (!process.env.WEBAUTHN_ORIGIN) {
    process.env.WEBAUTHN_ORIGIN = 'http://localhost:3000';
  }

  const { ensureSchema } = require('../../src/db/migrate-postgres');
  await ensureSchema();
  // Start from a known-clean DB so files run in any order share no rows.
  await cleanTestDb();
}

// FK-safe delete order: children before parents (workspaces before orgs/accounts).
const TABLES = [
  'yjs_doc_updates', 'sync_document_state', 'sync_workspace_state',
  'note_comments', 'note_activity', 'note_join_requests', 'note_invite_links', 'note_invitations', 'note_keys',
  'vault_key_params', 'vault_proof_challenges', 'account_vault_key_params',
  'workspace_join_requests', 'workspace_members', 'workspace_invites', 'workspace_keys',
  'compaction_locks', 'subscriptions', 'commits', 'sessions', 'ws_tickets', 'mfa_challenges',
  'devices', 'credentials', 'webauthn_challenges', 'quick_connect_codes',
  'email_aliases', 'audit_logs', 'sso_oidc_states', 'sso_configs',
  'asset_reservations',
  'workspaces',
  'org_keys', 'org_subscriptions', 'org_join_requests', 'org_invites', 'org_members',
  'organizations',
  'accounts',
];

async function cleanTestDb() {
  const { query } = require('../../src/db/postgres');
  for (const table of TABLES) {
    try {
      await query(`DELETE FROM ${table}`);
    } catch (err) {
      // Table might not exist yet; skip it but surface the reason.
      console.warn(`[test] Skipping DELETE on table ${table}: ${err.message}`);
    }
  }
}

module.exports = { setupTestDb, cleanTestDb, DEFAULT_DATABASE_URL };

// Hermetic teardown: any file that imports this helper leaves no rows behind,
// so the shared test DB stays clean for every other file (serial runs).
test.after(async () => {
  await cleanTestDb();
});
