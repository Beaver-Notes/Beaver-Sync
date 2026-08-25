'use strict';

const { query, transaction } = require('../db');

async function createEmptyState(workspaceId) {
  await query(
    'INSERT INTO sync_workspace_state (workspace_id, status, generation, updated_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
    [workspaceId, 'empty', 0, new Date().toISOString()]
  );
}

async function getStatus(workspaceId) {
  const { rows } = await query('SELECT status, generation FROM sync_workspace_state WHERE workspace_id = $1', [workspaceId]);
  return rows[0] ?? null;
}

async function listDocuments(workspaceId) {
  const { rows } = await query(`
    SELECT note_id, snapshot_generation, snapshot_key, checkpoint_ts, checkpoint_sequence, snapshot_ts
    FROM sync_document_state WHERE workspace_id = $1
    UNION
    SELECT note_id, 0, NULL, 0, 0, 0
    FROM yjs_doc_updates u WHERE workspace_id = $1
      AND NOT EXISTS (
        SELECT 1 FROM sync_document_state s
        WHERE s.workspace_id = $1 AND s.note_id = u.note_id
      )
    ORDER BY note_id
  `, [workspaceId]);
  return rows;
}

async function getVaultKeyParams(workspaceId) {
  const { rows } = await query(`
    SELECT id, owner_id, key_params_blob, created_at, updated_at
    FROM vault_key_params WHERE workspace_id = $1
  `, [workspaceId]);
  return rows[0] ?? null;
}

async function claimInitialization({ workspaceId, token, expiresAt, now }) {
  const result = await query(`
    UPDATE sync_workspace_state
    SET status = 'initializing', initialization_token = $1, initialization_expires_at = $2, updated_at = $3
    WHERE workspace_id = $4
      AND (status = 'empty' OR (status = 'initializing' AND initialization_expires_at <= $5))
  `, [token, expiresAt, now, workspaceId, now]);
  return result.rowCount > 0;
}

async function getInitializationClaim(workspaceId) {
  const { rows } = await query(`
    SELECT initialization_token, initialization_expires_at
    FROM sync_workspace_state WHERE workspace_id = $1 AND status = 'initializing'
  `, [workspaceId]);
  return rows[0] ?? null;
}

// Atomic: validates the claim token, upserts document mappings, flips the
// workspace to initialized. Resolves to an error-code string or null.
async function completeInitialization({ workspaceId, token, generation, documents, now }) {
  return transaction(async (client) => {
    const { rows } = await client.query(`
      SELECT initialization_token, initialization_expires_at
      FROM sync_workspace_state
      WHERE workspace_id = $1 AND status = 'initializing'
    `, [workspaceId]);
    const state = rows[0];
    if (!state || state.initialization_token !== token) return 'invalid_token';
    if (!state.initialization_expires_at || state.initialization_expires_at <= now) return 'expired_token';

    if (documents.length > 0) {
      const columnCount = 8;
      const placeholders = documents.map((_, i) => {
        const b = i * columnCount;
        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8})`;
      }).join(', ');
      const values = [];
      for (const d of documents) {
        values.push(
          workspaceId, d.noteId, d.snapshotGeneration, d.snapshotKey ?? null,
          d.checkpointTs, d.checkpointSequence, d.snapshotTs ?? 0, now
        );
      }
      const upsertSql = `
        INSERT INTO sync_document_state
          (workspace_id, note_id, snapshot_generation, snapshot_key, checkpoint_ts, checkpoint_sequence, snapshot_ts, updated_at)
        VALUES ${placeholders}
        ON CONFLICT(workspace_id, note_id) DO UPDATE SET
          snapshot_generation = excluded.snapshot_generation,
          snapshot_key = excluded.snapshot_key,
          checkpoint_ts = excluded.checkpoint_ts,
          checkpoint_sequence = excluded.checkpoint_sequence,
          snapshot_ts = excluded.snapshot_ts,
          updated_at = excluded.updated_at
      `;
      await client.query(upsertSql, values);
    }
    await client.query(`
      UPDATE sync_workspace_state
      SET status = 'initialized', generation = $1, initialization_token = NULL,
          initialization_expires_at = NULL, updated_at = $2
      WHERE workspace_id = $3
    `, [generation, now, workspaceId]);
    return null;
  });
}

async function resetState({ workspaceId, now }) {
  await transaction(async (client) => {
    await client.query(`
      UPDATE sync_workspace_state
      SET status = 'empty', generation = 0, initialization_token = NULL,
          initialization_expires_at = NULL, updated_at = $1
      WHERE workspace_id = $2
    `, [now, workspaceId]);
    await client.query('DELETE FROM sync_document_state WHERE workspace_id = $1', [workspaceId]);
    await client.query('DELETE FROM yjs_doc_updates WHERE workspace_id = $1', [workspaceId]);
    await client.query('DELETE FROM vault_key_params WHERE workspace_id = $1', [workspaceId]);
  });
}

async function listDownloadableSnapshots(workspaceId, noteIds) {
  const { rows } = await query(`
    SELECT note_id, snapshot_generation, snapshot_key, snapshot_ts
    FROM sync_document_state
    WHERE workspace_id = $1 AND note_id = ANY($2)
      AND snapshot_key IS NOT NULL AND snapshot_key != ''
  `, [workspaceId, noteIds]);
  return rows;
}

module.exports = {
  createEmptyState,
  getStatus,
  listDocuments,
  getVaultKeyParams,
  claimInitialization,
  getInitializationClaim,
  completeInitialization,
  resetState,
  listDownloadableSnapshots,
};
