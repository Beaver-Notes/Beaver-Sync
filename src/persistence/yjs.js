'use strict';

const { transaction, query } = require('../db');
const { getQuotaBytes, resolvePlanForAccount } = require('../lib/plans');
const { reconcileNoteOwnership } = require('../repositories/noteClaims');
const { identityOf, generateUpdateId, checkpointForRows } = require('./yjs-rooms');

// Write path: storing yjs updates into the journal. Reads/deletes/sync-state
// live in ./yjs-queries; room parsing/checkpoint helpers in ./yjs-rooms.
// This module re-exports both so existing `require('../persistence/yjs')`
// call sites keep working unchanged.

const MAX_BATCH_SIZE = 200;
const BATCH_INSERT_CHUNK = 500;

const UPDATE_INSERT_COLUMNS =
  '(id, workspace_id, note_id, update_data, update_encrypted, device_id, clock, ts, created_at)';
const UPDATE_COLUMN_COUNT = 9;

// Storage belongs to the workspace, so the quota is charged to the plan of the
// account that OWNS the workspace, not the plan of whoever pushed the update.
// Without this a free collaborator invited onto a note in a paid workspace
// resolves to plan 'free' (quota 0) and its pushes are rejected with 507.
// Runs on the transaction's executor so the read is part of the same atomic
// ledger transaction; a workspace row we cannot resolve falls back to the
// caller's plan, which degrades to quota 0 rather than unlimited.
async function workspaceOwnerPlan(executor, workspaceId) {
  const { rows } = await executor.query(`
    SELECT w.owner_id,
           os.plan AS org_plan,
           os.seats,
           s.plan AS owner_plan
      FROM workspaces w
      LEFT JOIN org_subscriptions os ON os.org_id = w.org_id
      LEFT JOIN subscriptions s ON s.account_id = w.owner_id
     WHERE w.id = $1
  `, [workspaceId]);
  if (!rows.length) return null;
  const row = rows[0];
  return {
    accountId: row.owner_id,
    // Same org-first resolution the rest of the codebase uses (and it honors
    // the PLAN_OVERRIDE dev/test escape hatch).
    plan: resolvePlanForAccount({
      orgSub: row.org_plan ? { plan: row.org_plan } : null,
      sub: row.owner_plan ? { plan: row.owner_plan } : null,
    }),
    seats: Number(row.seats) || 1,
  };
}

async function storeUpdatesBatch(workspaceId, noteId, updates) {
  if (!updates.length) return { accepted: 0, duplicate: 0, checkpoint: null };
  if (updates.length > MAX_BATCH_SIZE) {
    throw new RangeError(`maximum batch size of ${MAX_BATCH_SIZE} exceeded`);
  }

  return storeNotesBatch(workspaceId, [{ noteId, updates }]);
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
  let purgedClaims = [];

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
    return { accepted: 0, duplicate: 0, acceptedBytes: 0, checkpoint: null, checkpoints: {}, purgedClaims: [] };
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
    // First registration: note ids absent from BOTH journals become server-
    // known with this push. Reconcile their pre-existing collaboration rows so
    // a squatter who claimed the id while it was unpushed cannot survive into
    // key distribution. Detection is global (any workspace), matching
    // callerOwnsNote's "claimed everywhere" rule.
    const noteIds = [...new Set(notes.map((n) => n.noteId))];
    const { rows: knownRows } = await client.query(`
      SELECT DISTINCT note_id FROM yjs_doc_updates WHERE note_id = ANY($1)
      UNION
      SELECT note_id FROM sync_document_state WHERE note_id = ANY($1)
    `, [noteIds]);
    const known = new Set(knownRows.map((r) => r.note_id));
    const firstRegistered = noteIds.filter((id) => !known.has(id));
    purgedClaims = await reconcileNoteOwnership(client, workspaceId, firstRegistered);

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
        ON CONFLICT (workspace_id, note_id, device_id, clock) DO NOTHING
      `, chunk.flat());
      accepted += result.rowCount;
    }

    if (quota && acceptedBytes > 0 && quota.subscription) {
      // quota.plan carries the PUSHER's org-first effective plan; the ledger is
      // charged to the workspace owner's plan so a free collaborator on a paid
      // owner's workspace is billed to the owner, not rejected with 507.
      const owner = quota.workspaceId
        ? await workspaceOwnerPlan(client, quota.workspaceId)
        : null;
      const plan = owner ? owner.plan : (quota.plan || quota.subscription.plan);
      const seats = owner ? owner.seats : quota.seats;
      const accountId = owner ? owner.accountId : quota.accountId;
      let result;
      const quotaBytes = getQuotaBytes(plan, seats);
      // A plan with no cloud storage (free) has a 0-byte ceiling, so the guard
      // below can never pass. Reporting that as "quota exceeded" turns it into a
      // 507 the pusher retries forever; it is really "this plan has no storage".
      if (quotaBytes <= 0) {
        const error = new Error('Plan has no cloud storage');
        error.code = 'plan_storage_unavailable';
        throw error;
      }
      if (quota.workspaceId && ['team', 'enterprise'].includes(plan)) {
        result = await client.query(`UPDATE workspaces SET storage_used_bytes = storage_used_bytes + $1
          WHERE id = $2 AND ($3 = 'enterprise' OR storage_used_bytes + $1 <= $4)`,
          [acceptedBytes, quota.workspaceId, plan, quotaBytes]);
      } else if (plan !== 'enterprise') {
        result = await client.query(`UPDATE subscriptions SET storage_used_bytes = storage_used_bytes + $1
          WHERE account_id = $2 AND storage_used_bytes + $1 <= $3`,
          [acceptedBytes, accountId, quotaBytes]);
      }
      if (result && result.rowCount !== 1) {
        const error = new Error('Storage quota exceeded');
        error.code = 'storage_quota_exceeded';
        console.error('[quota] rejected', JSON.stringify({
          workspaceId: quota.workspaceId,
          plan,
          seats,
          accountId,
          acceptedBytes,
        }));
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
    purgedClaims,
  };
}

module.exports = {
  ...require('./yjs-rooms'),
  ...require('./yjs-queries'),
  storeUpdatesBatch,
  storeNotesBatch,
};
