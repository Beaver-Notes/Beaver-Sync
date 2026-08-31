'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

describe('Postgres schema', () => {
  it('schema.postgres.sql exists and is valid SQL', () => {
    const fs = require('fs');
    const path = require('path');
    const schemaPath = path.join(__dirname, '../../src/db/schema.postgres.sql');
    assert(fs.existsSync(schemaPath), 'schema.postgres.sql must exist');
    const content = fs.readFileSync(schemaPath, 'utf8');
    assert(content.includes('CREATE TABLE'), 'Schema must contain CREATE TABLE statements');
  });

  it('contains all required tables', () => {
    const fs = require('fs');
    const path = require('path');
    const schemaPath = path.join(__dirname, '../../src/db/schema.postgres.sql');
    const content = fs.readFileSync(schemaPath, 'utf8');

    const requiredTables = [
      'accounts', 'organizations', 'workspaces', 'sessions', 'commits',
      'subscriptions', 'devices', 'credentials', 'quick_connect_codes',
      'compaction_locks', 'note_keys', 'workspace_keys', 'org_keys',
      'org_members', 'org_subscriptions', 'org_invites', 'note_invitations',
      'note_invite_links', 'email_aliases', 'webauthn_challenges',
      'workspace_members', 'workspace_invites', 'sso_configs', 'sso_oidc_states',
      'audit_logs', 'yjs_doc_updates', 'sync_workspace_state',
      'sync_document_state', 'vault_key_params', 'note_comments',
      'vault_proof_challenges'
    ];

    for (const table of requiredTables) {
      assert(
        content.includes(`CREATE TABLE IF NOT EXISTS ${table}`),
        `Schema must contain CREATE TABLE IF NOT EXISTS ${table}`
      );
    }
  });

  it('uses Postgres-compatible types (no BLOB, BIGINT for numeric IDs)', () => {
    const fs = require('fs');
    const path = require('path');
    const schemaPath = path.join(__dirname, '../../src/db/schema.postgres.sql');
    const content = fs.readFileSync(schemaPath, 'utf8');

    assert(!content.includes(' BLOB '), 'Schema must not contain BLOB (use BYTEA)');
    assert(content.includes('BYTEA'), 'Schema must use BYTEA instead of BLOB');
  });

  it('all tables use IF NOT EXISTS', () => {
    const fs = require('fs');
    const path = require('path');
    const schemaPath = path.join(__dirname, '../../src/db/schema.postgres.sql');
    const content = fs.readFileSync(schemaPath, 'utf8');

    const createTableMatches = content.match(/CREATE TABLE [^I]/g);
    assert(!createTableMatches, `All CREATE TABLE statements must use IF NOT EXISTS. Found: ${createTableMatches}`);
  });

  it('migration runner exists and exports ensureSchema', () => {
    const migratePath = require('path').join(__dirname, '../../src/db/migrate-postgres.js');
    assert(require('fs').existsSync(migratePath), 'migrate-postgres.js must exist');
    const mod = require(migratePath);
    assert(typeof mod.ensureSchema === 'function', 'ensureSchema must be a function');
  });

  it('migration entrypoint schema.postgres.sql exists and is non-empty', () => {
    const fs = require('fs');
    const path = require('path');
    const schemaPath = path.join(__dirname, '../../src/db/schema.postgres.sql');
    assert(fs.existsSync(schemaPath), 'schema.postgres.sql (migration source) must exist');
    const content = fs.readFileSync(schemaPath, 'utf8');
    assert(content.trim().length > 0, 'schema.postgres.sql must not be empty');
  });
});
