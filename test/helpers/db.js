'use strict';

const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');

// Dedicated Postgres test database, separate from local dev data.
const DEFAULT_DATABASE_URL = 'postgresql://beaver:beaver@localhost:5432/beaver_test';

async function setupTestDb() {
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || DEFAULT_DATABASE_URL;
  }

  process.env.NODE_ENV = process.env.NODE_ENV || 'test';
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
}

// FK-safe delete order: children before parents (workspaces before orgs/accounts).
const TABLES = [
  'yjs_doc_updates', 'sync_document_state', 'sync_workspace_state',
  'note_comments', 'note_invite_links', 'note_invitations', 'note_keys',
  'vault_key_params', 'vault_proof_challenges',
  'workspace_members', 'workspace_invites', 'workspace_keys',
  'compaction_locks', 'subscriptions', 'commits', 'sessions',
  'devices', 'credentials', 'webauthn_challenges', 'quick_connect_codes',
  'email_aliases', 'audit_logs', 'sso_oidc_states', 'sso_configs',
  'workspaces',
  'org_keys', 'org_subscriptions', 'org_invites', 'org_members',
  'organizations',
  'accounts',
];

async function cleanTestDb() {
  const { query } = require('../../src/db/postgres');
  for (const table of TABLES) {
    try {
      await query(`DELETE FROM ${table}`);
    } catch (err) {
      // Table might not exist yet; ignore.
    }
  }
}

module.exports = { setupTestDb, cleanTestDb, DEFAULT_DATABASE_URL };
