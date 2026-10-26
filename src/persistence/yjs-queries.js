'use strict';

const { query } = require('../db');

// Read/query side of the yjs update journal: page loads, deletes, and
// sync-state bookkeeping.

const MAX_PULL_PAGE_SIZE = 500;

// Maximum age (ms) for a checkpoint to be considered fresh.
// Checkpoints older than this are treated as stale and the server returns
// `stale: true` so the client clears them and does a full re-pull.
const MAX_CURSOR_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

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

async function loadUpdatesAfter(workspaceId, noteId, checkpoint, limit, sinceTs = 0) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PULL_PAGE_SIZE) {
    throw new RangeError(`pull page size must be between 1 and ${MAX_PULL_PAGE_SIZE}`);
  }
  const devices = checkpoint || {};
  const hasCheckpoint = Object.keys(devices).length > 0;

  // --- Cursor expiry: reject checkpoints older than MAX_CURSOR_AGE_MS ---
  if (hasCheckpoint) {
    const maxTs = Math.max(...Object.values(devices).map((v) => v.ts));
    if (Date.now() - maxTs > MAX_CURSOR_AGE_MS) {
      console.log(`[pull-batch] note=${noteId} stale cursor (age=${Date.now() - maxTs}ms, max=${MAX_CURSOR_AGE_MS}ms)`);
      return { updates: [], nextCheckpoint: {}, hasMore: false, stale: true };
    }
  }

  const conditions = [];
  const params = [workspaceId, noteId];
  let paramIdx = 3;
  for (const [deviceId, value] of Object.entries(devices)) {
    conditions.push(`(device_id = $${paramIdx} AND (ts < $${paramIdx + 1} OR (ts = $${paramIdx + 1} AND clock <= $${paramIdx + 2})))`);
    params.push(deviceId, value.ts, value.sequence);
    paramIdx += 3;
  }
  const before = conditions.length ? `AND NOT (${conditions.join(' OR ')})` : '';
  let historyClamp = '';
  if (sinceTs > 0) {
    historyClamp = ` AND created_at >= $${paramIdx++}`;
    params.push(new Date(sinceTs).toISOString());
  }
  params.push(limit + 1);

  const { rows } = await query(`
    SELECT update_data, update_encrypted, device_id, clock, ts
    FROM yjs_doc_updates
    WHERE workspace_id = $1 AND note_id = $2
      ${before}${historyClamp}
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

  // NOTE: no "0 rows + history exists = stale" check here. Zero rows with a
  // valid checkpoint means the client is caught up, period: the exclusion
  // filter above already returns every row the checkpoint does not cover
  // (including post-compaction rows newer than a rotated cursor). Flagging
  // the steady state as stale wiped client checkpoints and forced a full
  // history re-pull on every other sync. Cursor age expiry above stays.

  return {
    updates: page,
    nextCheckpoint: last ? nextCheckpoint : {},
    hasMore,
    stale: false,
  };
}

// One round trip for every note in a pull-batch instead of one query per note.
// Same page semantics as `loadUpdatesAfter` (identical exclusion rule, ordering,
// checkpoint shape, empty-page rule); the per-note cursor-age and limit checks
// stay in JS so the SQL only carries notes that can return rows.
async function loadUpdatesBatch(workspaceId, requests, sinceTs = 0) {
  const pages = new Map();
  const pending = new Map();
  for (const { noteId, checkpoint, limit } of requests) {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PULL_PAGE_SIZE) {
      throw new RangeError(`pull page size must be between 1 and ${MAX_PULL_PAGE_SIZE}`);
    }
    const devices = checkpoint || {};
    if (Object.keys(devices).length > 0) {
      const maxTs = Math.max(...Object.values(devices).map((v) => v.ts));
      if (Date.now() - maxTs > MAX_CURSOR_AGE_MS) {
        console.log(`[pull-batch] note=${noteId} stale cursor (age=${Date.now() - maxTs}ms, max=${MAX_CURSOR_AGE_MS}ms)`);
        pages.set(noteId, { updates: [], nextCheckpoint: {}, hasMore: false, stale: true });
        continue;
      }
    }
    // First request per note wins: a duplicate id would double its rows.
    if (!pending.has(noteId)) pending.set(noteId, { noteId, devices, limit });
  }

  if (pending.size > 0) {
    const pendingArr = [...pending.values()];
    const noteIdsArr = pendingArr.map((p) => p.noteId);
    const checkpointsArr = pendingArr.map((p) => JSON.stringify(p.devices || {}));
    const limitsArr = pendingArr.map((p) => p.limit);
    const params = [noteIdsArr, workspaceId, checkpointsArr, limitsArr];
    let historyClamp = '';
    if (sinceTs > 0) {
      historyClamp = ` AND u.created_at >= $${params.length + 1}`;
      params.push(new Date(sinceTs).toISOString());
    }

    // LATERAL top-K per note: each note's index-ordered scan stops after
    // lim+1 rows. The row_number() version scanned all un-checkpointed
    // history per note before filtering, so cold cursors paid full-scan cost.
    const { rows } = await query(`
      WITH req AS MATERIALIZED (
        SELECT r.note_id, r.cp, r.lim
        FROM UNNEST($1::text[], $3::jsonb[], $4::int[]) AS r(note_id, cp, lim)
      )
      SELECT s.note_id, s.update_data, s.update_encrypted,
             s.device_id, s.clock, s.ts
      FROM req, LATERAL (
        SELECT u.note_id, u.update_data, u.update_encrypted,
               u.device_id, u.clock, u.ts
        FROM yjs_doc_updates u
        WHERE u.workspace_id = $2 AND u.note_id = req.note_id
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_each(req.cp) AS c(device_id, val)
            WHERE u.device_id = c.device_id
              AND (u.ts < (c.val->>'ts')::bigint
                OR (u.ts = (c.val->>'ts')::bigint AND u.clock <= (c.val->>'sequence')::bigint))
          )${historyClamp}
        ORDER BY u.ts ASC, u.clock ASC, u.device_id ASC
        LIMIT req.lim + 1
      ) s
      ORDER BY s.note_id, s.ts ASC, s.clock ASC, s.device_id ASC
    `, params);

    const grouped = new Map();
    for (const row of rows) {
      if (!grouped.has(row.note_id)) grouped.set(row.note_id, []);
      grouped.get(row.note_id).push(row);
    }

    for (const [noteId, entry] of pending) {
      const noteRows = grouped.get(noteId) || [];
      const hasMore = noteRows.length > entry.limit;
      const page = noteRows.slice(0, entry.limit).map((row) => ({
        data: row.update_data,
        encrypted: row.update_encrypted === 1,
        deviceId: row.device_id,
        clock: row.clock,
        sequence: row.clock,
        ts: row.ts,
      }));
      const nextCheckpoint = { ...entry.devices };
      for (const row of page) {
        const current = nextCheckpoint[row.deviceId];
        if (!current || row.ts > current.ts || (row.ts === current.ts && row.clock > current.sequence)) {
          nextCheckpoint[row.deviceId] = { ts: row.ts, sequence: row.clock };
        }
      }
      pages.set(noteId, {
        updates: page,
        nextCheckpoint: page.length ? nextCheckpoint : {},
        hasMore,
        stale: false,
      });
    }
  }

  const result = {};
  for (const { noteId } of requests) {
    if (!result[noteId]) {
      result[noteId] = pages.get(noteId) || { updates: [], nextCheckpoint: {}, hasMore: false, stale: false };
    }
  }
  return result;
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

async function loadAllUpdates(workspaceId, noteId, sinceTs = 0) {
  let historyClamp = '';
  const params = [workspaceId, noteId];
  if (sinceTs > 0) {
    historyClamp = ' AND created_at >= $3';
    params.push(new Date(sinceTs).toISOString());
  }
  const { rows } = await query(`
    SELECT update_data, update_encrypted, device_id, clock, ts
    FROM yjs_doc_updates
    WHERE workspace_id = $1 AND note_id = $2${historyClamp}
    ORDER BY ts ASC, clock ASC
  `, params);

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
    -- spare pre-migration baseline blobs (migrate-postgres.js); last-resort copy
    AND id NOT LIKE 'migration-%'
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

// Monotonic per-note snapshot advance for the client's post-compaction
// snapshot upload (routes/sync-state.js /snapshot-promote). Unlike the
// exact-match promoteDocumentSyncState, this only moves forward
// (snapshot_generation < new), so two devices compacting the same note
// converge instead of one looping on a stale generation: an already
// recorded equal-or-newer generation is an idempotent no-op.
async function advanceDocumentSyncState(workspaceId, noteId, generation, key, snapshotTs, checkpoint) {
  const now = new Date().toISOString();
  const { rowCount } = await query(`
    UPDATE sync_document_state
    SET snapshot_generation = $1, snapshot_key = $2,
        checkpoint_ts = COALESCE($3, checkpoint_ts),
        checkpoint_sequence = COALESCE($4, checkpoint_sequence),
        snapshot_ts = $5, updated_at = $6
    WHERE workspace_id = $7 AND note_id = $8 AND snapshot_generation < $1
  `, [generation, key, checkpoint?.ts ?? null, checkpoint?.sequence ?? null, snapshotTs ?? 0, now, workspaceId, noteId]);
  if (rowCount === 1) return true;
  const { rowCount: insertCount } = await query(`
    INSERT INTO sync_document_state
      (workspace_id, note_id, snapshot_generation, snapshot_key, checkpoint_ts, checkpoint_sequence, snapshot_ts, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (workspace_id, note_id) DO NOTHING
  `, [workspaceId, noteId, generation, key, checkpoint?.ts ?? 0, checkpoint?.sequence ?? 0, snapshotTs ?? 0, now]);
  return insertCount === 1;
}

async function deleteJournalRows(workspaceId, noteId, rows) {
  if (!rows.length) return;
  const conditions = rows.map((_, i) => `(device_id = $${i * 2 + 3} AND clock = $${i * 2 + 4})`);
  const params = [workspaceId, noteId, ...rows.flatMap(row => [row.deviceId, row.clock ?? row.sequence])];
  await query(
    `DELETE FROM yjs_doc_updates WHERE workspace_id = $1 AND note_id = $2 AND (${conditions.join(' OR ')})`,
    params
  );
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
  getWorkspaceSyncState,
  getDocumentSyncState,
  loadUpdatesAfter,
  loadUpdatesBatch,
  loadUpdatesSince,
  loadAllUpdates,
  deleteUpdatesBefore,
  deleteUpdatesForNote,
  deleteUnencryptedUpdatesForNote,
  updateDocumentSyncState,
  promoteDocumentSyncState,
  advanceDocumentSyncState,
  deleteJournalRows,
  getUpdateCount,
  listNoteIds,
};
