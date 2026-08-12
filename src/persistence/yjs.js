'use strict';

const crypto = require('crypto');
const { query, transaction } = require('../db');

const MAX_BATCH_SIZE = 200;
const MAX_PULL_PAGE_SIZE = 500;
const BATCH_INSERT_CHUNK = 500;
const TEAM_WORKSPACE_QUOTA = 50 * 1024 * 1024 * 1024;

const roomPattern = /^workspace:([a-zA-Z0-9-]+):note:([a-zA-Z0-9-]+)$/;
const UPDATE_IDENTITY_SEP = '\u0000';

const UPDATE_INSERT_COLUMNS =
  '(id, workspace_id, note_id, update_data, update_encrypted, device_id, clock, ts, created_at)';
const UPDATE_COLUMN_COUNT = 9;

function identityOf(noteId, deviceId, clock) {
  return `${noteId}${UPDATE_IDENTITY_SEP}${deviceId}${UPDATE_IDENTITY_SEP}${clock}`;
}

function parseRoomName(documentName) {
  const match = roomPattern.exec(documentName);
  if (!match) return null;
  return { workspaceId: match[1], noteId: match[2] };
}

function generateUpdateId() {
  return `${Date.now()}-${crypto.randomUUID()}`;
}

async function storeUpdate(workspaceId, noteId, updateData, deviceId, clock, encrypted = false) {
  const now = new Date().toISOString();
  await query(`
    INSERT INTO yjs_doc_updates
    (id, workspace_id, note_id, update_data, update_encrypted, device_id, clock, ts, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT DO NOTHING
  `, [
    generateUpdateId(), workspaceId, noteId,
    Buffer.isBuffer(updateData) ? updateData : Buffer.from(updateData),
    encrypted ? 1 : 0, deviceId, clock, Date.now(), now
  ]);
}

async function storeUpdatesBatch(workspaceId, noteId, updates) {
  if (!updates.length) return { accepted: 0, duplicate: 0, checkpoint: null };
  if (updates.length > MAX_BATCH_SIZE) {
    throw new RangeError(`maximum batch size of ${MAX_BATCH_SIZE} exceeded`);
  }

  return storeNotesBatch(workspaceId, [{ noteId, updates }]);
}

function compareCheckpoints(a, b) {
  return a.ts - b.ts || a.sequence - b.sequence || (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0);
}

function checkpointForRows(rows) {
  return rows
    .map((row) => ({ ts: row.ts, sequence: row.clock, deviceId: row.device_id }))
    .sort(compareCheckpoints)
    .at(-1) ?? null;
}

async function getAcceptedBytes(workspaceId, notes) {
  const seen = new Set();
  let bytes = 0;
  for (const { noteId, updates } of notes) {
    for (const update of updates) {
      const identity = `${noteId}\u0000${update.deviceId}\u0000${update.sequence}`;
      if (!seen.has(identity)) {
        const { rows } = await query(`
          SELECT 1 FROM yjs_doc_updates
          WHERE workspace_id = $1 AND note_id = $2 AND device_id = $3 AND clock = $4
        `, [workspaceId, noteId, update.deviceId, update.sequence]);
        if (!rows.length) {
          bytes += Buffer.isBuffer(update.data) ? update.data.byteLength : Buffer.byteLength(update.data);
        }
      }
      seen.add(identity);
    }
  }
  return bytes;
}

async function storeNotesBatch(workspaceId, notes, quota = null) {
  for (const { updates } of notes) {
    if (updates.length > MAX_BATCH_SIZE) {
      throw new RangeError(`maximum batch size of ${MAX_BATCH_SIZE} exceeded`);
    }
  }

  const now = new Date().toISOString();
  let accepted = 0;
  let acceptedBytes = 0;

  const batch = notes.flatMap(({ noteId, updates }) => updates.map((u) => [
    generateUpdateId(),
    workspaceId,
    noteId,
    Buffer.isBuffer(u.data) ? u.data : Buffer.from(u.data),
    u.encrypted ? 1 : 0,
    u.deviceId,
    u.sequence ?? u.clock,
    u.ts ?? Date.now(),
    now,
  ]));

  if (batch.length === 0) {
    return { accepted: 0, duplicate: 0, acceptedBytes: 0, checkpoint: null, checkpoints: {} };
  }

  // Collapse within-batch duplicates (same note, device, clock) so each update
  // identity is inserted at most once per call.
  const seen = new Set();
  const uniqueRows = [];
  for (const row of batch) {
    const identity = identityOf(row[2], row[5], row[6]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    uniqueRows.push(row);
  }

  await transaction(async (client) => {
    // Determine which identities already exist so acceptedBytes only counts
    // rows this call actually inserts.
    const existingIdentities = new Set();
    {
      const identityParams = uniqueRows.flatMap((row) => [row[2], row[5], row[6]]);
      const placeholders = uniqueRows
        .map((_, i) => `(note_id = $${i * 3 + 2} AND device_id = $${i * 3 + 3} AND clock = $${i * 3 + 4})`)
        .join(' OR ');
      const { rows } = await client.query(`
        SELECT note_id, device_id, clock
        FROM yjs_doc_updates
        WHERE workspace_id = $1 AND (${placeholders})
      `, [workspaceId, ...identityParams]);
      for (const r of rows) {
        existingIdentities.add(identityOf(r.note_id, r.device_id, r.clock));
      }
    }

    for (const row of uniqueRows) {
      if (!existingIdentities.has(identityOf(row[2], row[5], row[6]))) {
        acceptedBytes += row[3].byteLength;
      }
    }

    // Insert in chunks to bound statement size and round-trips.
    for (let i = 0; i < uniqueRows.length; i += BATCH_INSERT_CHUNK) {
      const chunk = uniqueRows.slice(i, i + BATCH_INSERT_CHUNK);
      const placeholders = chunk
        .map((_, r) => `(${Array.from({ length: UPDATE_COLUMN_COUNT }, (_, c) => `$${r * UPDATE_COLUMN_COUNT + c + 1}`).join(', ')})`)
        .join(', ');
      const result = await client.query(`
        INSERT INTO yjs_doc_updates
        ${UPDATE_INSERT_COLUMNS}
        VALUES ${placeholders}
        ON CONFLICT DO NOTHING
      `, chunk.flat());
      accepted += result.rowCount;
    }

    if (quota && acceptedBytes > 0 && quota.subscription) {
      let result;
      if (quota.workspaceId && ['team', 'enterprise'].includes(quota.subscription.plan)) {
        result = await client.query(`UPDATE workspaces SET storage_used_bytes = storage_used_bytes + $1
          WHERE id = $2 AND ($3 = 'enterprise' OR storage_used_bytes + $1 <= $4)`,
          [acceptedBytes, quota.workspaceId, quota.subscription.plan, TEAM_WORKSPACE_QUOTA]);
      } else if (quota.subscription.plan !== 'enterprise') {
        result = await client.query(`UPDATE subscriptions SET storage_used_bytes = storage_used_bytes + $1
          WHERE account_id = $2 AND storage_used_bytes + $1 <= storage_quota_bytes`,
          [acceptedBytes, quota.accountId]);
      }
      if (result && result.rowCount !== 1) {
        const error = new Error('Storage quota exceeded');
        error.code = 'storage_quota_exceeded';
        throw error;
      }
    }
  });

  const identityParams = uniqueRows.flatMap((row) => [row[2], row[5], row[6]]);
  const placeholders = uniqueRows
    .map((_, i) => `(note_id = $${i * 3 + 2} AND device_id = $${i * 3 + 3} AND clock = $${i * 3 + 4})`)
    .join(' OR ');
  const storedRows = uniqueRows.length
    ? (await query(`
      SELECT note_id, ts, clock, device_id
      FROM yjs_doc_updates
      WHERE workspace_id = $1 AND (${placeholders})
    `, [workspaceId, ...identityParams])).rows
    : [];
  const checkpoint = checkpointForRows(storedRows);
  const checkpoints = Object.fromEntries(notes.map(({ noteId }) => [
    noteId,
    checkpointForRows(storedRows.filter((row) => row.note_id === noteId)),
  ]));

  return {
    accepted,
    duplicate: batch.length - accepted,
    acceptedBytes,
    checkpoint,
    checkpoints,
  };
}

async function getWorkspaceSyncState(workspaceId) {
  const { rows } = await query('SELECT * FROM sync_workspace_state WHERE workspace_id = $1', [workspaceId]);
  const row = rows[0];
  if (!row) return null;
  return {
    workspaceId: row.workspace_id,
    status: row.status,
    generation: row.generation,
    initializationToken: row.initialization_token,
    initializationExpiresAt: row.initialization_expires_at,
    updatedAt: row.updated_at,
  };
}

async function getDocumentSyncState(workspaceId, noteId) {
  const { rows } = await query(`
    SELECT * FROM sync_document_state WHERE workspace_id = $1 AND note_id = $2
  `, [workspaceId, noteId]);
  const row = rows[0];
  if (!row) return null;
  return {
    workspaceId: row.workspace_id,
    noteId: row.note_id,
    snapshotGeneration: row.snapshot_generation,
    snapshotKey: row.snapshot_key,
    checkpointTs: row.checkpoint_ts,
    checkpointSequence: row.checkpoint_sequence,
    updatedAt: row.updated_at,
  };
}

async function loadUpdatesAfter(workspaceId, noteId, checkpoint, limit) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PULL_PAGE_SIZE) {
    throw new RangeError(`pull page size must be between 1 and ${MAX_PULL_PAGE_SIZE}`);
  }
  const devices = checkpoint || {};
  const conditions = [];
  const params = [workspaceId, noteId];
  let paramIdx = 3;
  for (const [deviceId, value] of Object.entries(devices)) {
    conditions.push(`(device_id = $${paramIdx} AND (ts < $${paramIdx + 1} OR (ts = $${paramIdx + 1} AND clock <= $${paramIdx + 2})))`);
    params.push(deviceId, value.ts, value.sequence);
    paramIdx += 3;
  }
  const before = conditions.length ? `AND NOT (${conditions.join(' OR ')})` : '';
  params.push(limit + 1);

  const { rows } = await query(`
    SELECT update_data, update_encrypted, device_id, clock, ts
    FROM yjs_doc_updates
    WHERE workspace_id = $1 AND note_id = $2
      ${before}
    ORDER BY ts ASC, clock ASC, device_id ASC LIMIT $${paramIdx}
  `, params);

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).map((row) => ({
    data: row.update_data,
    encrypted: row.update_encrypted === 1,
    deviceId: row.device_id,
    clock: row.clock,
    sequence: row.clock,
    ts: row.ts,
  }));
  const last = page.at(-1);

  const nextCheckpoint = { ...devices };
  for (const row of page) {
    const current = nextCheckpoint[row.deviceId];
    if (!current || row.ts > current.ts || (row.ts === current.ts && row.clock > current.sequence)) {
      nextCheckpoint[row.deviceId] = { ts: row.ts, sequence: row.clock };
    }
  }
  return {
    updates: page,
    nextCheckpoint: last ? nextCheckpoint : checkpoint,
    hasMore,
  };
}

async function loadUpdatesSince(workspaceId, noteId, sinceTs) {
  const { rows } = await query(`
    SELECT update_data, update_encrypted, device_id, clock, ts
    FROM yjs_doc_updates
    WHERE workspace_id = $1 AND note_id = $2 AND ts > $3
    ORDER BY ts ASC, clock ASC
  `, [workspaceId, noteId, sinceTs]);

  return rows.map((row) => ({
    data: row.update_data,
    encrypted: row.update_encrypted === 1,
    deviceId: row.device_id,
    clock: row.clock,
    ts: row.ts,
  }));
}

async function loadAllUpdates(workspaceId, noteId) {
  const { rows } = await query(`
    SELECT update_data, update_encrypted, device_id, clock, ts
    FROM yjs_doc_updates
    WHERE workspace_id = $1 AND note_id = $2
    ORDER BY ts ASC, clock ASC
  `, [workspaceId, noteId]);

  return rows.map((row) => ({
    data: row.update_data,
    encrypted: row.update_encrypted === 1,
    deviceId: row.device_id,
    clock: row.clock,
    ts: row.ts,
  }));
}

async function deleteUpdatesBefore(workspaceId, noteId, beforeTs) {
  await query(`
    DELETE FROM yjs_doc_updates
    WHERE workspace_id = $1 AND note_id = $2 AND ts < $3
  `, [workspaceId, noteId, beforeTs]);
}

async function deleteUpdatesForNote(workspaceId, noteId) {
  await query(`
    DELETE FROM yjs_doc_updates
    WHERE workspace_id = $1 AND note_id = $2
  `, [workspaceId, noteId]);
}

async function deleteUnencryptedUpdatesForNote(workspaceId, noteId) {
  await query(`
    DELETE FROM yjs_doc_updates
    WHERE workspace_id = $1 AND note_id = $2 AND update_encrypted = 0
  `, [workspaceId, noteId]);
}

async function updateDocumentSyncState(workspaceId, noteId, generation, key, checkpoint) {
  const { rows: existing } = await query(`
    SELECT checkpoint_ts, checkpoint_sequence
    FROM sync_document_state
    WHERE workspace_id = $1 AND note_id = $2
  `, [workspaceId, noteId]);
  const current = existing[0];
  await query(`
    INSERT INTO sync_document_state
      (workspace_id, note_id, snapshot_generation, snapshot_key,
       checkpoint_ts, checkpoint_sequence, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT(workspace_id, note_id) DO UPDATE SET
      snapshot_generation = excluded.snapshot_generation,
      snapshot_key = excluded.snapshot_key,
      checkpoint_ts = excluded.checkpoint_ts,
      checkpoint_sequence = excluded.checkpoint_sequence,
      updated_at = excluded.updated_at
  `, [
    workspaceId,
    noteId,
    generation,
    key,
    checkpoint?.ts ?? current?.checkpoint_ts ?? 0,
    checkpoint?.sequence ?? current?.checkpoint_sequence ?? 0,
    new Date().toISOString(),
  ]);
}

async function promoteDocumentSyncState(workspaceId, noteId, expectedGeneration, generation, key, checkpoint) {
  const { rowCount } = await query(`
    UPDATE sync_document_state
    SET snapshot_generation = $1, snapshot_key = $2, checkpoint_ts = COALESCE($3, checkpoint_ts), checkpoint_sequence = COALESCE($4, checkpoint_sequence), updated_at = $5
    WHERE workspace_id = $6 AND note_id = $7 AND snapshot_generation = $8
  `, [
    generation,
    key,
    checkpoint?.ts ?? null,
    checkpoint?.sequence ?? null,
    new Date().toISOString(),
    workspaceId,
    noteId,
    expectedGeneration,
  ]);
  if (rowCount === 1) return true;
  const { rowCount: insertCount } = await query(`
    INSERT INTO sync_document_state
      (workspace_id, note_id, snapshot_generation, snapshot_key, checkpoint_ts, checkpoint_sequence, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT DO NOTHING
  `, [workspaceId, noteId, generation, key, checkpoint?.ts ?? 0, checkpoint?.sequence ?? 0, new Date().toISOString()]);
  return insertCount === 1;
}

async function deleteJournalRows(workspaceId, noteId, rows) {
  await transaction(async (client) => {
    for (const row of rows) {
      await client.query(`DELETE FROM yjs_doc_updates WHERE workspace_id = $1 AND note_id = $2 AND device_id = $3 AND clock = $4`,
        [workspaceId, noteId, row.deviceId, row.clock ?? row.sequence]);
    }
  });
}

async function getUpdateCount(workspaceId, noteId) {
  const { rows } = await query(`
    SELECT COUNT(*) AS count FROM yjs_doc_updates
    WHERE workspace_id = $1 AND note_id = $2
  `, [workspaceId, noteId]);
  return rows[0]?.count ?? 0;
}

async function listNoteIds(workspaceId) {
  const { rows } = await query(`
    SELECT DISTINCT note_id FROM yjs_doc_updates
    WHERE workspace_id = $1
  `, [workspaceId]);
  return rows.map(r => r.note_id);
}

module.exports = {
  parseRoomName,
  storeUpdate,
  storeUpdatesBatch,
  storeNotesBatch,
  getAcceptedBytes,
  getWorkspaceSyncState,
  getDocumentSyncState,
  loadUpdatesAfter,
  loadUpdatesSince,
  loadAllUpdates,
  deleteUpdatesBefore,
  deleteUpdatesForNote,
  deleteUnencryptedUpdatesForNote,
  updateDocumentSyncState,
  promoteDocumentSyncState,
  deleteJournalRows,
  getUpdateCount,
  listNoteIds,
};
