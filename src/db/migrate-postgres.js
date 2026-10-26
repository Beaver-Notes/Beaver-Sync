'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { query, getPool } = require('./postgres');

const SCHEMA_ADVISORY_LOCK_KEY = 930743;

async function ensureSchema() {
  const schemaPath = path.join(__dirname, 'schema.postgres.sql');
  if (!fs.existsSync(schemaPath)) {
    throw new Error('schema.postgres.sql not found; Postgres backend requires it');
  }

  const lockClient = await getPool().connect();
  try {
    await lockClient.query('SELECT pg_advisory_lock($1)', [SCHEMA_ADVISORY_LOCK_KEY]);
    const schema = fs.readFileSync(schemaPath, 'utf8');
    await query(schema);
    // 02.1: username is a display label, not unique — drop legacy UNIQUE constraint
    try {
      await query('ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_username_key');
    } catch {}
    try {
      await query('DROP INDEX IF EXISTS accounts_username_key');
    } catch {}
    // 02.2: recovery code — single active per account, HMAC-hashed
    try {
      await query('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS recovery_code_hash TEXT');
    } catch {}
    try {
      await query('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS recovery_code_generated_at TIMESTAMPTZ');
    } catch {}
    // 02.3: email verification soft gate — bool + single-use hashed token 24h TTL
    try {
      await query('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE');
    } catch {}
    try {
      await query('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS verification_token_hash TEXT');
    } catch {}
    try {
      await query('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS verification_expires_at TIMESTAMPTZ');
    } catch {}
    // 02.4: password reset — single-use hashed token 1h TTL
    try {
      await query('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS password_reset_token_hash TEXT');
    } catch {}
    try {
      await query('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS password_reset_expires_at TIMESTAMPTZ');
    } catch {}
    // 02.5: TOTP 2FA encrypted secret + pending + replay protection
    try {
      await query('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS totp_secret_encrypted TEXT');
    } catch {}
    try {
      await query('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS totp_pending_secret_encrypted TEXT');
    } catch {}
    try {
      await query('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS totp_pending_expires_at TIMESTAMPTZ');
    } catch {}
    try {
      await query('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS totp_last_timestep BIGINT');
    } catch {}
    try {
      await query(`CREATE TABLE IF NOT EXISTS mfa_challenges (
        id_hash TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL
      )`);
    } catch {}
    // backfill for legacy workspaces table created before vault_wrapped_keys/emoji/color existed
    try {
      await query('ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS vault_wrapped_keys TEXT');
    } catch {}
    try {
      await query('ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS emoji TEXT');
    } catch {}
    try {
      await query('ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS color TEXT');
    } catch {}
    try {
      await query('ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS org_id TEXT REFERENCES organizations(id)');
    } catch {}
    // Workspace key envelopes are per-device now, so an account's second device
    // can unwrap its own envelope. Existing rows keep device_id NULL and stay
    // readable as a legacy account-level envelope. The old PK on
    // (workspace_id, user_id) must go or only one device could ever hold a row.
    try {
      await query('ALTER TABLE workspace_keys ADD COLUMN IF NOT EXISTS device_id TEXT');
    } catch {}
    try {
      await query('ALTER TABLE workspace_keys DROP CONSTRAINT IF EXISTS workspace_keys_pkey');
    } catch {}
    try {
      await query('CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_keys_device ON workspace_keys(workspace_id, user_id, device_id)');
    } catch {}
    // 04.1: asset quota reservations (presign preflight + reap)
    try {
      await query(`CREATE TABLE IF NOT EXISTS asset_reservations (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
        asset_key TEXT NOT NULL,
        size_bytes BIGINT NOT NULL CHECK(size_bytes >= 0),
        status TEXT NOT NULL CHECK(status IN ('pending', 'confirmed')),
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      )`);
    } catch {}
    try { await query('CREATE INDEX IF NOT EXISTS idx_asset_reservations_account ON asset_reservations(account_id, status, expires_at)'); } catch {}
    try { await query('CREATE INDEX IF NOT EXISTS idx_asset_reservations_expires ON asset_reservations(expires_at) WHERE status = \'pending\''); } catch {}
    // L8: collaborator removal rotates the note key. The generation stamps each
    // rotation so a replay of a pre-rotation envelope is distinguishable and
    // the current generation is server-recorded.
    try {
      await query('ALTER TABLE note_keys ADD COLUMN IF NOT EXISTS generation BIGINT NOT NULL DEFAULT 0');
    } catch {}
    // Invitations carry the owning workspace so shared-with-me can resolve a note
    // before its first push. Nullable, and SET NULL rather than CASCADE so
    // deleting a workspace cannot silently delete a live share.
    try {
      await query('ALTER TABLE note_invitations ADD COLUMN IF NOT EXISTS workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL');
    } catch {}
    // Activity kind moves into the client-encrypted payload. Legacy rows keep
    // their readable kind; new writes store NULL (drop the NOT NULL so an
    // upgraded database accepts them).
    try {
      await query('ALTER TABLE note_activity ALTER COLUMN kind DROP NOT NULL');
    } catch {}
    // 02.6: server-sealed columns renamed from *_encrypted (server holds the key);
    // dead columns dropped: commits.payload_encrypted, note_comments.anchor_{from,to}
    // Each rename is guarded on catalog state: schema.postgres.sql runs first and
    // may have pre-created the _sealed column, so an unconditional RENAME would
    // fail on the duplicate and silently strand the existing _encrypted data.
    const renames = [
      ['accounts', 'email_encrypted', 'email_sealed'],
      ['accounts', 'totp_secret_encrypted', 'totp_secret_sealed'],
      ['accounts', 'totp_pending_secret_encrypted', 'totp_pending_secret_sealed'],
      ['email_aliases', 'email_encrypted', 'email_sealed'],
      ['audit_logs', 'metadata_encrypted', 'metadata_sealed'],
      ['sso_configs', 'idp_cert_encrypted', 'idp_cert_sealed'],
      ['sso_configs', 'sp_private_key_encrypted', 'sp_private_key_sealed'],
      ['sso_configs', 'oidc_client_secret_encrypted', 'oidc_client_secret_sealed']
    ];
    for (const [table, from, to] of renames) {
      try {
        await query(`DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = '${table}' AND column_name = '${from}')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name = '${table}' AND column_name = '${to}') THEN
    ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to};
  END IF;
END $$`);
      } catch {}
    }
    try { await query('ALTER TABLE commits DROP COLUMN IF EXISTS payload_encrypted'); } catch {}
    try { await query('ALTER TABLE note_comments DROP COLUMN IF EXISTS anchor_from'); } catch {}
    try { await query('ALTER TABLE note_comments DROP COLUMN IF EXISTS anchor_to'); } catch {}
    // Per-user encrypted reactions (emoji list is note-key encrypted, like bodies).
    try { await query('ALTER TABLE note_comments DROP COLUMN IF EXISTS reactions'); } catch {}
    try {
      await query(`CREATE TABLE IF NOT EXISTS note_comment_reactions (
        id               TEXT PRIMARY KEY,
        comment_id       TEXT NOT NULL REFERENCES note_comments(id) ON DELETE CASCADE,
        user_id          TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        emojis_encrypted TEXT NOT NULL,
        emojis_iv        TEXT NOT NULL,
        created_at       TEXT NOT NULL
      )`);
    } catch {}
    try {
      await query('CREATE INDEX IF NOT EXISTS idx_note_comment_reactions_comment ON note_comment_reactions(comment_id)');
    } catch {}
  } finally {
    try {
      await lockClient.query('SELECT pg_advisory_unlock($1)', [SCHEMA_ADVISORY_LOCK_KEY]);
    } finally {
      lockClient.release();
    }
  }
}

/**
 * One-shot migration: fold yjs_documents rows into yjs_doc_updates journal.
 * Runs under advisory lock; idempotent (skips if journal already has data >= snapshot generation).
 * Returns migration counts for recording.
 */
async function migrateYjsDocumentsToJournal() {
  const lockClient = await getPool().connect();
  try {
    await lockClient.query('SELECT pg_advisory_lock($1)', [SCHEMA_ADVISORY_LOCK_KEY]);

    // Check if yjs_documents table exists and has rows
    const { rows: docRows } = await lockClient.query(`
      SELECT doc_name, blob, updated_at FROM yjs_documents
    `)

    if (docRows.length === 0) {
      return { migrated: 0, skipped: 0, deleted: 0 }
    }

    const { parseRoomName } = require('../persistence/yjs')
    let migrated = 0
    let skipped = 0
    let deleted = 0

    for (const row of docRows) {
      const parsed = parseRoomName(row.doc_name)
      if (!parsed || !parsed.noteId) {
        console.warn(`[migration] Skipping invalid doc_name: ${row.doc_name}`)
        skipped++
        continue
      }

      const { workspaceId, noteId } = parsed

      // Check if journal already has data for this document (idempotency)
      const { rows: journalRows } = await lockClient.query(`
        SELECT COUNT(*)::int AS count FROM yjs_doc_updates
        WHERE workspace_id = $1 AND note_id = $2
      `, [workspaceId, noteId])

      if (journalRows[0]?.count > 0) {
        console.log(`[migration] Journal already has data for ${workspaceId}/${noteId}, skipping`)
        skipped++
        // Still delete the yjs_documents row since journal is authoritative
        await lockClient.query('DELETE FROM yjs_documents WHERE doc_name = $1', [row.doc_name])
        deleted++
        continue
      }

      // Insert the blob as a journal update
      // Use a synthetic device_id/clock to represent the pre-migration state
      const deviceId = 'relay'
      const clock = Math.floor(new Date(row.updated_at).getTime() / 1000) // seconds since epoch
      const ts = clock * 1000 // milliseconds
      const updateId = `migration-${crypto.randomUUID()}`

      await lockClient.query(`
        INSERT INTO yjs_doc_updates (id, workspace_id, note_id, update_data, update_encrypted, device_id, clock, ts, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (workspace_id, note_id, device_id, clock) DO NOTHING
      `, [updateId, workspaceId, noteId, row.blob, 0, deviceId, clock, ts, row.updated_at])

      // Delete the yjs_documents row
      await lockClient.query('DELETE FROM yjs_documents WHERE doc_name = $1', [row.doc_name])

      migrated++
      deleted++
      console.log(`[migration] Migrated ${row.doc_name} -> journal (${row.blob?.byteLength ?? 0} bytes)`)
    }

    return { migrated, skipped, deleted }
  } finally {
    try {
      await lockClient.query('SELECT pg_advisory_unlock($1)', [SCHEMA_ADVISORY_LOCK_KEY])
    } finally {
      lockClient.release()
    }
  }
}

module.exports = { ensureSchema, migrateYjsDocumentsToJournal };
