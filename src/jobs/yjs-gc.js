'use strict';

const crypto = require('crypto');
const Y = require('yjs');
const { query } = require('../db/postgres');
const { historyCutoffTs } = require('../lib/plan-lifecycle');

const GC_ADVISORY_KEY = 930745;

function getIntervalMs() {
  const raw = process.env.YJS_GC_INTERVAL_MS;
  if (raw === undefined || raw === '') return 0;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) || n < 0 ? 0 : n;
}

function hashWorkspaceId(id) {
  const h = crypto.createHash('md5').update(String(id)).digest();
  return h.readInt32BE(0);
}

async function tryAdvisoryLock(workspaceId) {
  const key2 = hashWorkspaceId(workspaceId);
  const { rows } = await query('SELECT pg_try_advisory_lock($1, $2) AS locked', [GC_ADVISORY_KEY, key2]);
  return rows[0]?.locked === true;
}

async function unlockAdvisory(workspaceId) {
  const key2 = hashWorkspaceId(workspaceId);
  try { await query('SELECT pg_advisory_unlock($1, $2)', [GC_ADVISORY_KEY, key2]); } catch {}
}

async function tryGlobalLock() {
  const { rows } = await query('SELECT pg_try_advisory_lock($1) AS locked', [GC_ADVISORY_KEY]);
  return rows[0]?.locked === true;
}
async function unlockGlobal() {
  try { await query('SELECT pg_advisory_unlock($1)', [GC_ADVISORY_KEY]); } catch {}
}

async function resolveWorkspacePlan(workspaceId) {
  const { rows: wsRows } = await query('SELECT owner_id, org_id FROM workspaces WHERE id = $1', [workspaceId]);
  if (!wsRows[0]) return { plan: 'free', cutoffTs: historyCutoffTs('free'), ownerId: null, orgId: null };
  const ownerId = wsRows[0].owner_id;
  const orgId = wsRows[0].org_id;
  const { rows: subRows } = await query('SELECT plan FROM subscriptions WHERE account_id = $1', [ownerId]);
  let plan = subRows[0]?.plan ?? 'free';
  if (orgId) {
    const { rows: orgSubRows } = await query('SELECT plan FROM org_subscriptions WHERE org_id = $1', [orgId]);
    const orgPlan = orgSubRows[0]?.plan;
    if (orgPlan) {
      const { rows: mem } = await query('SELECT 1 FROM org_members WHERE org_id = $1 AND account_id = $2 LIMIT 1', [orgId, ownerId]);
      if (mem.length) plan = orgPlan;
      else {
        const { rows: wm } = await query('SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND account_id = $2 LIMIT 1', [workspaceId, ownerId]);
        if (wm.length) plan = orgPlan;
      }
    }
  }
  // PLAN_OVERRIDE bypass for test parity with plan-resolution (non-prod)
  if (process.env.NODE_ENV !== 'production' && process.env.PLAN_OVERRIDE) {
    const { VALID_PLANS } = require('../lib/plans');
    if (VALID_PLANS.has(process.env.PLAN_OVERRIDE)) plan = process.env.PLAN_OVERRIDE;
  }
  return { plan, cutoffTs: historyCutoffTs(plan), ownerId, orgId };
}

function snapshotKeyFor(workspaceId, noteId, generation) {
  return `yjs/${workspaceId}/${noteId}/${generation}.yjs`;
}

async function compactNote(workspaceId, noteId, cutoffTs, ownerId, plan, now) {
  const { rows } = await query(
    `SELECT id, update_data, update_encrypted, device_id, clock, ts, created_at, octet_length(update_data) AS size
     FROM yjs_doc_updates WHERE workspace_id = $1 AND note_id = $2 ORDER BY ts ASC, clock ASC, device_id ASC`,
    [workspaceId, noteId]
  );
  if (rows.length === 0) return { compacted: 0, reclaimed: 0 };

  const aged = rows.filter((r) => new Date(r.created_at).getTime() < cutoffTs);
  if (aged.length === 0) return { compacted: 0, reclaimed: 0 };

  // Build snapshot from aged rows only
  let snapshotData;
  try {
    const doc = new Y.Doc();
    for (const r of aged) {
      // encrypted rows still contain bytes but not valid Yjs; try will throw -> fallback
      Y.applyUpdate(doc, r.update_data);
    }
    snapshotData = Y.encodeStateAsUpdate(doc);
  } catch {
    snapshotData = Buffer.concat(aged.map((r) => r.update_data));
  }
  const snapBuf = Buffer.isBuffer(snapshotData) ? snapshotData : Buffer.from(snapshotData);
  const snapshotSize = snapBuf.length;
  const deletedBytes = aged.reduce((s, r) => s + Number(r.size ?? r.update_data.length ?? 0), 0);

  // r2 put with parameterized? use r2 service (zero-knowledge, just bytes)
  const r2 = require('../services/r2');
  const { rows: stateRows } = await query('SELECT snapshot_generation FROM sync_document_state WHERE workspace_id=$1 AND note_id=$2', [workspaceId, noteId]);
  const nextGen = (stateRows[0]?.snapshot_generation ?? 0) + 1;
  const key = snapshotKeyFor(workspaceId, noteId, nextGen);
  const maxTs = Math.max(...aged.map((r) => r.ts));
  const maxClock = Math.max(...aged.map((r) => r.clock));

  // Put snapshot (snapshot-lock style: advisory already held per workspace)
  await r2.put(key, snapBuf, 'application/octet-stream');

  // Upsert sync_document_state (+ checkpoint)
  await query(
    `INSERT INTO sync_document_state (workspace_id, note_id, snapshot_generation, snapshot_key, checkpoint_ts, checkpoint_sequence, snapshot_ts, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (workspace_id, note_id) DO UPDATE SET snapshot_generation=excluded.snapshot_generation, snapshot_key=excluded.snapshot_key, checkpoint_ts=excluded.checkpoint_ts, checkpoint_sequence=excluded.checkpoint_sequence, snapshot_ts=excluded.snapshot_ts, updated_at=excluded.updated_at`,
    [workspaceId, noteId, nextGen, key, maxTs, maxClock, maxTs, new Date(now).toISOString()]
  );

  // Delete aged rows (parameterized IN)
  const agedIds = aged.map((r) => r.id);
  for (let i = 0; i < agedIds.length; i += 500) {
    const chunk = agedIds.slice(i, i + 500);
    const placeholders = chunk.map((_, idx) => `$${idx + 3}`).join(',');
    await query(`DELETE FROM yjs_doc_updates WHERE workspace_id=$1 AND note_id=$2 AND id IN (${placeholders})`, [workspaceId, noteId, ...chunk]);
  }

  // Quota netting (mirror routes/snapshot.js:46-199)
  const netChange = snapshotSize - deletedBytes;
  if (netChange !== 0 && plan !== 'enterprise') {
    const { rows: wsRows2 } = await query('SELECT org_id FROM workspaces WHERE id=$1', [workspaceId]);
    const wsOrgId = wsRows2[0]?.org_id;
    const isTeamWithOrg = wsOrgId && ['team', 'enterprise'].includes(plan);
    if (isTeamWithOrg) {
      await query('UPDATE workspaces SET storage_used_bytes = GREATEST(0, storage_used_bytes + $1) WHERE id=$2', [netChange, workspaceId]);
    } else if (ownerId) {
      await query('UPDATE subscriptions SET storage_used_bytes = GREATEST(0, storage_used_bytes + $1) WHERE account_id=$2', [netChange, ownerId]);
    }
  }

  return { compacted: aged.length, reclaimed: deletedBytes - snapshotSize, snapshotSize, deletedBytes, key };
}

async function sweepOrphanedRelayArtifacts() {
  try {
    const { rows } = await query('SELECT doc_name FROM yjs_documents');
    if (rows.length === 0) return 0;
    // Delete all orphaned after Item 1 migration - they are superseded
    const result = await query('DELETE FROM yjs_documents');
    return result.rowCount ?? rows.length;
  } catch (e) {
    if (String(e.message).includes('does not exist')) return 0;
    throw e;
  }
}

async function runGc(opts = {}) {
  const now = opts.now ?? Date.now();
  const start = Date.now();

  // Global advisory lock so scale-out instances don't double-run batch
  const locked = await tryGlobalLock();
  if (!locked) {
    console.log('[yjs-gc] skipped: gc already running (advisory lock held)');
    return { skipped: true, reason: 'locked' };
  }

  let docsCompacted = 0;
  let bytesReclaimed = 0;
  let workspacesProcessed = 0;
  let notesProcessed = 0;
  try {
    // Collect workspace ids that have yjs data
    const { rows: wsRows } = await query(
      `SELECT DISTINCT workspace_id FROM yjs_doc_updates
       UNION SELECT workspace_id FROM sync_document_state
       UNION SELECT workspace_id FROM sync_workspace_state`
    );
    const workspaceIds = wsRows.map((r) => r.workspace_id).filter(Boolean);

    for (const workspaceId of workspaceIds) {
      // Per-workspace advisory lock (additive, try)
      const wsLocked = await tryAdvisoryLock(workspaceId);
      if (!wsLocked) continue;
      try {
        const { plan, cutoffTs, ownerId } = await resolveWorkspacePlan(workspaceId);

        // List note ids for workspace (union of journal + snapshot state)
        const { rows: noteRows } = await query(
          `SELECT DISTINCT note_id FROM yjs_doc_updates WHERE workspace_id=$1
           UNION SELECT note_id FROM sync_document_state WHERE workspace_id=$1`,
          [workspaceId]
        );
        const noteIds = noteRows.map((r) => r.note_id).filter(Boolean);
        workspacesProcessed++;

        for (const noteId of noteIds) {
          notesProcessed++;
          const res = await compactNote(workspaceId, noteId, cutoffTs, ownerId, plan, now);
          if (res.compacted > 0) {
            docsCompacted++;
            bytesReclaimed += res.reclaimed;
          }
        }
      } finally {
        await unlockAdvisory(workspaceId);
      }
    }

    const swept = await sweepOrphanedRelayArtifacts();

    const duration = Date.now() - start;
    console.log(`[yjs-gc] workspaces=${workspacesProcessed} notes=${notesProcessed} compacted=${docsCompacted} reclaimed=${bytesReclaimed} swept=${swept} duration=${duration}ms`);
    return { workspacesProcessed, notesProcessed, docsCompacted, bytesReclaimed, swept, duration };
  } finally {
    await unlockGlobal();
  }
}

let timer = null;

function startGcScheduler(app) {
  const interval = getIntervalMs();
  if (!interval) {
    app.log.info('[yjs-gc] disabled (YJS_GC_INTERVAL_MS=0)');
    return null;
  }
  app.log.info(`[yjs-gc] scheduler enabled interval=${interval}ms`);
  timer = setInterval(() => {
    runGc().catch((err) => {
      try { app.log.error({ err: err.message }, '[yjs-gc] run failed'); } catch { console.error('[yjs-gc] run failed', err.message); }
    });
  }, interval);
  if (timer.unref) timer.unref();
  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
    timer = null;
  });
  return timer;
}

function stopGcScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { getIntervalMs, runGc, startGcScheduler, stopGcScheduler, sweepOrphanedRelayArtifacts, GC_ADVISORY_KEY, tryGlobalLock, unlockGlobal };
