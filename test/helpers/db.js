'use strict';

const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

// Default test Postgres connection string
const DEFAULT_DATABASE_URL = 'postgresql://beaver:beaver@localhost:5432/beaver';

function setupTestDb() {
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
}

async function cleanTestDb() {
  const { query } = require('../src/db/postgres');

  const tables = [
    'yjs_doc_updates', 'sync_document_state', 'sync_workspace_state',
    'note_comments', 'note_invite_links', 'note_invitations', 'note_keys',
    'workspace_members', 'workspace_invites', 'workspace_keys',
    'org_members', 'org_invites', 'org_subscriptions', 'org_keys',
    'organizations', 'audit_logs', 'sso_oidc_states', 'sso_configs',
    'email_aliases', 'webauthn_challenges', 'quick_connect_codes',
    'compaction_locks', 'credentials', 'devices', 'sessions',
    'subscriptions', 'commits', 'workspaces', 'accounts',
  ];

  for (const table of tables) {
    try {
      await query(`DELETE FROM ${table}`);
    } catch (err) {
      // Table might not exist, ignore
    }
  }
}

module.exports = { setupTestDb, cleanTestDb, DEFAULT_DATABASE_URL };
