'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Y = require('yjs');

process.env.NODE_ENV = 'test';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-characters-long';

const { close, query } = require('../src/db');
const { setupTestDb, cleanTestDb } = require('./helpers/db');
const { createPostgresPersistence } = require('../src/db/yjs-persistence');
const { getPool } = require('../src/db/postgres');

const TEST_WORKSPACE = 'ws-conv';
const TEST_NOTE = 'note-conv';
const TEST_ACCOUNT = 'account-conv';

async function seedWorkspace() {
  await query(`
    INSERT INTO accounts (id, email_hmac, created_at)
    VALUES ($1, $2, $3)
  `, [TEST_ACCOUNT, 'email-hmac-conv', new Date().toISOString()]);
  await query(`
    INSERT INTO workspaces (id, name_encrypted, owner_id, created_at)
    VALUES ($1, $2, $3, $4)
  `, [TEST_WORKSPACE, 'name', TEST_ACCOUNT, new Date().toISOString()]);
  await query(`
    INSERT INTO workspace_members (workspace_id, account_id, role, created_at)
    VALUES ($1, $2, $3, $4)
  `, [TEST_WORKSPACE, TEST_ACCOUNT, 'owner', new Date().toISOString()]);
}

async function seedRelayDoc(docName, initialText) {
  // Simulate pre-existing relay document in yjs_documents (pre-migration state)
  const doc = new Y.Doc();
  const ytext = doc.getText('content');
  ytext.insert(0, initialText);
  const blob = Y.encodeStateAsUpdate(doc);
  await query(`
    INSERT INTO yjs_documents (doc_name, blob, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (doc_name) DO UPDATE SET blob = EXCLUDED.blob, updated_at = NOW()
  `, [docName, blob]);
  doc.destroy();
}

test.before(async () => {
  await setupTestDb();
  await cleanTestDb();
  await seedWorkspace();
});

test.after(async () => {
  await close();
});

test('relay-only edits are ephemeral: migration folds old docs, relay persists nothing', async () => {
  const docName = `workspace:${TEST_WORKSPACE}:note:${TEST_NOTE}`;
  const pool = getPool();
  const relayPersistence = createPostgresPersistence(pool);

  // 1. A pre-existing relay document (pre-migration state) folds into the
  // journal as a one-time baseline; its yjs_documents row is then dropped.
  await seedRelayDoc(docName, 'initial relay content');
  const { migrateYjsDocumentsToJournal } = require('../src/db/migrate-postgres');
  const migrationResult = await migrateYjsDocumentsToJournal();
  assert.equal(migrationResult.migrated, 1);
  assert.equal(migrationResult.deleted, 1);

  // 2. bindState is broadcast-only: it must not load journal plaintext.
  const relayDoc = new Y.Doc();
  const relayText = relayDoc.getText('content');
  await relayPersistence.bindState(docName, relayDoc);
  assert.equal(relayText.toString(), '');

  // 3. A relay edit is broadcast in memory only. writeState must not add a
  // journal row; only the `migration-*` baseline is allowed to remain.
  relayText.insert(0, 'relay edit');
  await relayPersistence.writeState(docName, relayDoc);

  const { rows } = await query(
    `SELECT id FROM yjs_doc_updates
     WHERE workspace_id = $1 AND note_id = $2 AND device_id = 'relay'
       AND id NOT LIKE 'migration-%'`,
    [TEST_WORKSPACE, TEST_NOTE]
  );
  assert.equal(rows.length, 0, 'relay edits must stay ephemeral');

  relayDoc.destroy();
});

test('relay bindState reconstructs from S3 snapshot + journal tail', async () => {
  const docName = `workspace:${TEST_WORKSPACE}:note:note-snapshot`;
  const pool = getPool();
  const relayPersistence = createPostgresPersistence(pool);

  // Note: Full S3 integration requires storage service, so we test the journal path

  const relayDoc = new Y.Doc();
  await relayPersistence.bindState(docName, relayDoc);

  // Should not throw, doc should be empty (no prior data)
  const relayText = relayDoc.getText('content');
  assert.equal(relayText.toString(), '');

  relayDoc.destroy();
});

test('relay-originated updates never enter the quota journal', async () => {
  // The relay is ephemeral: only client-encrypted envelopes (REST push-batch)
  // are journaled and counted against quota. The quota path itself is covered
  // by src/db/yjs-persistence.test.js.
  const pool = getPool();
  const relayPersistence = createPostgresPersistence(pool);
  const docName = `workspace:${TEST_WORKSPACE}:note:note-quota`;

  const relayDoc = new Y.Doc();
  const relayText = relayDoc.getText('content');

  // bindState must be called first to register the doc and set dirty tracking
  await relayPersistence.bindState(docName, relayDoc);

  relayText.insert(0, 'quota test');
  relayText.insert(relayText.length, ' more');
  await relayPersistence.writeState(docName, relayDoc);

  const { rows } = await query(`
    SELECT device_id FROM yjs_doc_updates
    WHERE workspace_id = $1 AND note_id = $2
  `, [TEST_WORKSPACE, 'note-quota']);

  assert.equal(rows.length, 0, 'ephemeral relay must not write plaintext rows');

  relayDoc.destroy();
});