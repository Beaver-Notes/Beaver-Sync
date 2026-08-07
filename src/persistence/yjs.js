'use strict';

const crypto = require('crypto');
const { getDb } = require('../db');

const MAX_BATCH_SIZE = 200;
const MAX_PULL_PAGE_SIZE = 500;
const TEAM_WORKSPACE_QUOTA = 50 * 1024 * 1024 * 1024;

const roomPattern = /^workspace:([a-zA-Z0-9-]+):note:([a-zA-Z0-9-]+)$/;

function parseRoomName(documentName) {
  const match = roomPattern.exec(documentName);
  if (!match) return null;
  return { workspaceId: match[1], noteId: match[2] };
}

function generateUpdateId() {
  return `${Date.now()}-${crypto.randomUUID()}`;
}

async function storeUpdate(workspaceId, noteId, updateData, deviceId, clock, encrypted = false) {
  const db = getDb();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT OR IGNORE INTO yjs_doc_updates
    (id, workspace_id, note_id, update_data, update_encrypted, device_id, clock, ts, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    generateUpdateId(),
    workspaceId,
    noteId,
    Buffer.isBuffer(updateData) ? updateData : Buffer.from(updateData),
    encrypted ? 1 : 0,
    deviceId,
    clock,
    Date.now(),
    now,
  );
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
  const db = getDb();
  const lookup = db.prepare(`
    SELECT 1 FROM yjs_doc_updates
    WHERE workspace_id = ? AND note_id = ? AND device_id = ? AND clock = ?
  `);
  const seen = new Set();
  let bytes = 0;
  for (const { noteId, updates } of notes) {
    for (const update of updates) {
      const identity = `${noteId}\u0000${update.deviceId}\u0000${update.sequence}`;
      if (!seen.has(identity) && !lookup.get(workspaceId, noteId, update.deviceId, update.sequence)) {
        bytes += Buffer.isBuffer(update.data) ? update.data.byteLength : Buffer.byteLength(update.data);
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

  const db = getDb();
  const now = new Date().toISOString();

  const insert = db.prepare(`
    INSERT OR IGNORE INTO yjs_doc_updates
    (id, workspace_id, note_id, update_data, update_encrypted, device_id, clock, ts, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

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

  let accepted = 0;
  let acceptedBytes = 0;
  const writeBatch = db.transaction((rows) => {
    for (const row of rows) {
      const result = insert.run(...row);
      accepted += result.changes;
      acceptedBytes += result.changes * row[3].byteLength;
    }
    if (quota && acceptedBytes > 0 && quota.subscription) {
      let result;
      if (quota.workspaceId && ['team', 'enterprise'].includes(quota.subscription.plan)) {
        result = db.prepare(`UPDATE workspaces SET storage_used_bytes = storage_used_bytes + ?
          WHERE id = ? AND (? = 'enterprise' OR storage_used_bytes + ? <= ?)`).run(
          acceptedBytes, quota.workspaceId, quota.subscription.plan, acceptedBytes, TEAM_WORKSPACE_QUOTA);
      } else if (quota.subscription.plan !== 'enterprise') {
        result = db.prepare(`UPDATE subscriptions SET storage_used_bytes = storage_used_bytes + ?
          WHERE account_id = ? AND storage_used_bytes + ? <= storage_quota_bytes`).run(
          acceptedBytes, quota.accountId, acceptedBytes);
      }
      if (result && result.changes !== 1) {
        const error = new Error('Storage quota exceeded');
        error.code = 'storage_quota_exceeded';
        throw error;
      }
    }
  });

  writeBatch(batch);

  const identityParams = batch.flatMap((row) => [row[2], row[5], row[6]]);
  const storedRows = batch.length
    ? db.prepare(`
      SELECT ts, clock, device_id
      FROM yjs_doc_updates
      WHERE workspace_id = ? AND (${batch.map(() => '(note_id = ? AND device_id = ? AND clock = ?)').join(' OR ')})
    `).all(workspaceId, ...identityParams)
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
  const db = getDb();
  const row = db.prepare('SELECT * FROM sync_workspace_state WHERE workspace_id = ?').get(workspaceId);
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
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM sync_document_state WHERE workspace_id = ? AND note_id = ?
  `).get(workspaceId, noteId);
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
  const db = getDb();
  const devices = checkpoint || {};
  const conditions = Object.entries(devices).map(() => '(device_id = ? AND (ts < ? OR (ts = ? AND clock <= ?)))');
  const params = [];
  for (const [deviceId, value] of Object.entries(devices)) params.push(deviceId, value.ts, value.ts, value.sequence);
  const before = conditions.length ? `AND NOT (${conditions.join(' OR ')})` : '';
  const rows = db.prepare(`
    SELECT update_data, update_encrypted, device_id, clock, ts
    FROM yjs_doc_updates
    WHERE workspace_id = ? AND note_id = ?
      ${before}
    ORDER BY ts ASC, clock ASC, device_id ASC LIMIT ?
  `).all(workspaceId, noteId, ...params, limit + 1);

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
  const db = getDb();
  const rows = db.prepare(`
    SELECT update_data, update_encrypted, device_id, clock, ts
    FROM yjs_doc_updates
    WHERE workspace_id = ? AND note_id = ? AND ts > ?
    ORDER BY ts ASC, clock ASC
  `).all(workspaceId, noteId, sinceTs);

  return rows.map((row) => ({
    data: row.update_data,
    encrypted: row.update_encrypted === 1,
    deviceId: row.device_id,
    clock: row.clock,
    ts: row.ts,
  }));
}

async function loadAllUpdates(workspaceId, noteId) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT update_data, update_encrypted, device_id, clock, ts
    FROM yjs_doc_updates
    WHERE workspace_id = ? AND note_id = ?
    ORDER BY ts ASC, clock ASC
  `).all(workspaceId, noteId);

  return rows.map((row) => ({
    data: row.update_data,
    encrypted: row.update_encrypted === 1,
    deviceId: row.device_id,
    clock: row.clock,
    ts: row.ts,
  }));
}

async function deleteUpdatesBefore(workspaceId, noteId, beforeTs) {
  const db = getDb();
  db.prepare(`
    DELETE FROM yjs_doc_updates
    WHERE workspace_id = ? AND note_id = ? AND ts < ?
  `).run(workspaceId, noteId, beforeTs);
}

async function deleteUpdatesForNote(workspaceId, noteId) {
  const db = getDb();
  db.prepare(`
    DELETE FROM yjs_doc_updates
    WHERE workspace_id = ? AND note_id = ?
  `).run(workspaceId, noteId);
}

async function deleteUnencryptedUpdatesForNote(workspaceId, noteId) {
  const db = getDb();
  db.prepare(`
    DELETE FROM yjs_doc_updates
    WHERE workspace_id = ? AND note_id = ? AND update_encrypted = 0
  `).run(workspaceId, noteId);
}

async function updateDocumentSyncState(workspaceId, noteId, generation, key, checkpoint) {
  const db = getDb();
  const current = db.prepare(`
    SELECT checkpoint_ts, checkpoint_sequence
    FROM sync_document_state
    WHERE workspace_id = ? AND note_id = ?
  `).get(workspaceId, noteId);
  db.prepare(`
    INSERT INTO sync_document_state
      (workspace_id, note_id, snapshot_generation, snapshot_key,
       checkpoint_ts, checkpoint_sequence, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, note_id) DO UPDATE SET
      snapshot_generation = excluded.snapshot_generation,
      snapshot_key = excluded.snapshot_key,
      checkpoint_ts = excluded.checkpoint_ts,
      checkpoint_sequence = excluded.checkpoint_sequence,
      updated_at = excluded.updated_at
  `).run(
    workspaceId,
    noteId,
    generation,
    key,
    checkpoint?.ts ?? current?.checkpoint_ts ?? 0,
    checkpoint?.sequence ?? current?.checkpoint_sequence ?? 0,
    new Date().toISOString(),
  );
}

async function promoteDocumentSyncState(workspaceId, noteId, expectedGeneration, generation, key, checkpoint) {
  const db = getDb();
  const result = db.prepare(`
    UPDATE sync_document_state
    SET snapshot_generation = ?, snapshot_key = ?, checkpoint_ts = COALESCE(?, checkpoint_ts), checkpoint_sequence = COALESCE(?, checkpoint_sequence), updated_at = ?
    WHERE workspace_id = ? AND note_id = ? AND snapshot_generation = ?
  `).run(
    generation,
    key,
    checkpoint?.ts ?? null,
    checkpoint?.sequence ?? null,
    new Date().toISOString(),
    workspaceId,
    noteId,
    expectedGeneration,
  );
  if (result.changes === 1) return true;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO sync_document_state
      (workspace_id, note_id, snapshot_generation, snapshot_key, checkpoint_ts, checkpoint_sequence, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(workspaceId, noteId, generation, key, checkpoint?.ts ?? 0, checkpoint?.sequence ?? 0, new Date().toISOString());
  return insert.changes === 1;
}

async function deleteJournalRows(workspaceId, noteId, rows) {
  const db = getDb();
  const remove = db.prepare(`DELETE FROM yjs_doc_updates WHERE workspace_id = ? AND note_id = ? AND device_id = ? AND clock = ?`);
  const transaction = db.transaction((captured) => {
    for (const row of captured) remove.run(workspaceId, noteId, row.deviceId, row.clock ?? row.sequence);
  });
  transaction(rows);
}

async function getUpdateCount(workspaceId, noteId) {
  const db = getDb();
  const row = db.prepare(`
    SELECT COUNT(*) AS count FROM yjs_doc_updates
    WHERE workspace_id = ? AND note_id = ?
  `).get(workspaceId, noteId);
  return row?.count ?? 0;
}

async function listNoteIds(workspaceId) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT DISTINCT note_id FROM yjs_doc_updates
    WHERE workspace_id = ?
  `).all(workspaceId);
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
