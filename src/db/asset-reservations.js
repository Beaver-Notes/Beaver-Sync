'use strict';

const crypto = require('crypto');
const { query, transaction } = require('./postgres');
const { getQuotaBytes } = require('../lib/plans');
const { isEnterpriseMode } = require('../lib/license');

const RESERVATION_TTL_SECONDS = 3600;
const ASSET_RESERVATION_ADVISORY_KEY = 930746;

function hashAccountId(accountId) {
  const h = crypto.createHash('md5').update(String(accountId)).digest();
  return h.readInt32BE(0);
}

async function advisoryLock(client, accountId) {
  const key2 = hashAccountId(accountId);
  await client.query('SELECT pg_advisory_xact_lock($1, $2)', [ASSET_RESERVATION_ADVISORY_KEY, key2]);
}

// Sum of live pending reservations for scope. Parameterized SQL only.
async function sumPendingForAccount(accountId, workspaceId, client) {
  const q = client ? (t, p) => client.query(t, p) : query;
  let sql;
  let params;
  if (workspaceId) {
    sql = `SELECT COALESCE(SUM(size_bytes),0)::bigint AS total FROM asset_reservations WHERE account_id=$1 AND workspace_id=$2 AND status='pending' AND expires_at > NOW()`;
    params = [accountId, workspaceId];
  } else {
    sql = `SELECT COALESCE(SUM(size_bytes),0)::bigint AS total FROM asset_reservations WHERE account_id=$1 AND workspace_id IS NULL AND status='pending' AND expires_at > NOW()`;
    params = [accountId];
  }
  const { rows } = await q(sql, params);
  return Number(rows[0]?.total ?? 0);
}

// Resolve effective quota and used bytes for account/workspace. Uses parameterized queries via client if provided.
async function resolveQuotaAndUsed(accountId, workspaceId, client) {
  if (isEnterpriseMode()) return { quota: Number.MAX_SAFE_INTEGER, used: 0, plan: 'enterprise' };
  const q = client ? (t, p) => client.query(t, p) : query;

  // Try org/workspace path if workspaceId given
  if (workspaceId) {
    const { rows: wsRows } = await q('SELECT org_id, storage_used_bytes FROM workspaces WHERE id=$1', [workspaceId]);
    const ws = wsRows[0];
    if (ws) {
      // Resolve plan: prefer org subscription if member, else personal
      let plan = 'free';
      let seats = 1;
      if (ws.org_id) {
        const { rows: orgSubRows } = await q('SELECT plan, seats FROM org_subscriptions WHERE org_id=$1', [ws.org_id]);
        const orgSub = orgSubRows[0];
        if (orgSub) {
          const { rows: mem } = await q('SELECT 1 FROM org_members WHERE org_id=$1 AND account_id=$2 LIMIT 1', [ws.org_id, accountId]);
          let isMember = mem.length > 0;
          if (!isMember) {
            const { rows: wm } = await q('SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND account_id=$2 LIMIT 1', [workspaceId, accountId]);
            if (wm.length > 0) isMember = true;
          }
          if (isMember) {
            plan = orgSub.plan;
            seats = orgSub.seats ?? 1;
          }
        }
      }
      if (plan === 'free') {
        const { rows: subRows } = await q('SELECT plan FROM subscriptions WHERE account_id=$1', [accountId]);
        if (subRows[0]?.plan) plan = subRows[0].plan;
      }
      // Check PLAN_OVERRIDE parity (non-prod)
      if (process.env.NODE_ENV !== 'production' && process.env.PLAN_OVERRIDE) {
        const { VALID_PLANS } = require('../lib/plans');
        if (VALID_PLANS.has(process.env.PLAN_OVERRIDE)) plan = process.env.PLAN_OVERRIDE;
      }
      let quota = getQuotaBytes(plan, seats);
      // Allow DB override for tests (org_subscriptions.storage_quota_bytes)
      if (ws.org_id) {
        const { rows: orgSubOverride } = await q('SELECT storage_quota_bytes FROM org_subscriptions WHERE org_id=$1', [ws.org_id]);
        const override = orgSubOverride[0]?.storage_quota_bytes;
        if (override != null && Number(override) > 0 && Number(override) < quota) quota = Number(override);
        if (override != null && Number(override) > 0 && plan === 'free') quota = Number(override);
      }
      const used = Number(ws.storage_used_bytes ?? 0);
      // Enterprise unlimited
      if (plan === 'enterprise') return { quota: Number.MAX_SAFE_INTEGER, used, plan };
      return { quota, used, plan };
    }
  }

  // Personal/account scope
  const { rows: subRows } = await q('SELECT plan, status, storage_used_bytes, storage_quota_bytes FROM subscriptions WHERE account_id=$1', [accountId]);
  const sub = subRows[0] || null;
  let plan = sub?.plan ?? 'free';
  const seats = 1;
  // Try org fallback via orgIdFromReq-style: if no workspace, plan is just sub plan
  if (process.env.NODE_ENV !== 'production' && process.env.PLAN_OVERRIDE) {
    const { VALID_PLANS } = require('../lib/plans');
    if (VALID_PLANS.has(process.env.PLAN_OVERRIDE)) plan = process.env.PLAN_OVERRIDE;
  }
  // Allow tests / admin to override quota via DB column (if set and < plan quota, honor it)
  let quota = getQuotaBytes(plan, seats);
  if (sub?.storage_quota_bytes != null && Number(sub.storage_quota_bytes) > 0 && Number(sub.storage_quota_bytes) < quota) {
    quota = Number(sub.storage_quota_bytes);
  }
  // Also handle free plan with explicit quota override (e.g., test sets 1024)
  if (sub?.storage_quota_bytes != null && Number(sub.storage_quota_bytes) > 0 && plan === 'free') {
    quota = Number(sub.storage_quota_bytes);
  }
  const used = Number(sub?.storage_used_bytes ?? 0);
  if (plan === 'enterprise') return { quota: Number.MAX_SAFE_INTEGER, used, plan };
  return { quota, used, plan };
}

/**
 * Attempt to reserve quota for presign batch.
 * Must be called within advisory lock to prevent concurrent overcommit.
 * Returns { ok: true, reservedBytes } or { ok: false, quota, used, pending, requested }.
 */
async function reserveForPresign({ accountId, workspaceId, items }) {
  // items: [{ assetKey, sizeBytes }]
  const requestedTotal = items.reduce((s, it) => s + (Number(it.sizeBytes) || 0), 0);

  // Fast path: enterprise or quota 0 edge? Still need transaction for consistency
  return transaction(async (client) => {
    await advisoryLock(client, accountId);

    const { quota, used } = await resolveQuotaAndUsed(accountId, workspaceId, client);
    // console.log('[reserve] quota', quota, 'used', used, 'pending calc next', 'account', accountId);
    // Unlimited enterprise
    if (quota === Number.MAX_SAFE_INTEGER) {
      // Insert reservations without quota check
      const now = new Date();
      const expiresAt = new Date(now.getTime() + RESERVATION_TTL_SECONDS * 1000);
      for (const it of items) {
        const id = crypto.randomUUID();
        await client.query(
          `INSERT INTO asset_reservations (id, account_id, workspace_id, asset_key, size_bytes, status, expires_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [id, accountId, workspaceId || null, it.assetKey, it.sizeBytes, 'pending', expiresAt.toISOString(), now.toISOString()]
        );
      }
      return { ok: true, reservedBytes: requestedTotal };
    }

    if (quota <= 0) {
      // No quota (free tier) -> block any positive size
      if (requestedTotal > 0) {
        const pending = await sumPendingForAccount(accountId, workspaceId, client);
        return { ok: false, quota, used, pending, requested: requestedTotal };
      }
    }

    const pending = await sumPendingForAccount(accountId, workspaceId, client);
    const projected = used + pending + requestedTotal;
    if (projected > quota) {
      return { ok: false, quota, used, pending, requested: requestedTotal };
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + RESERVATION_TTL_SECONDS * 1000);
    for (const it of items) {
      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO asset_reservations (id, account_id, workspace_id, asset_key, size_bytes, status, expires_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, accountId, workspaceId || null, it.assetKey, it.sizeBytes, 'pending', expiresAt.toISOString(), now.toISOString()]
      );
    }
    return { ok: true, reservedBytes: requestedTotal };
  });
}

/**
 * Confirm reservations for keys that have been verified in R2.
 * Marks pending->confirmed and returns number confirmed.
 * Idempotent: second call for same keys is no-op.
 */
async function confirmReservations({ accountId, workspaceId, keys, sizeByKey }) {
  // sizeByKey: Map assetKey -> sizeBytes (from r2.stat)
  let confirmed = 0;
  let totalSizeBytes = 0;
  for (const assetKey of keys) {
    const sizeBytes = sizeByKey.get(assetKey);
    if (sizeBytes == null) continue;
    // Try to transition pending->confirmed for this key (most recent pending)
    const { rowCount } = await query(
      `UPDATE asset_reservations SET status='confirmed' WHERE id IN (
         SELECT id FROM asset_reservations WHERE account_id=$1 AND asset_key=$2 AND status='pending' AND expires_at > NOW() ${workspaceId ? 'AND workspace_id=$3' : 'AND workspace_id IS NULL'} ORDER BY created_at DESC LIMIT 1
       )`,
      workspaceId ? [accountId, assetKey, workspaceId] : [accountId, assetKey]
    );
    if (rowCount > 0) {
      confirmed++;
      totalSizeBytes += sizeBytes;
    } else {
      // Check if already confirmed (idempotent retry) -> skip accounting to avoid double-count
      const { rows } = await query(
        `SELECT 1 FROM asset_reservations WHERE account_id=$1 AND asset_key=$2 AND status='confirmed' LIMIT 1`,
        [accountId, assetKey]
      );
      if (rows.length > 0) {
        // Already confirmed, skip
        continue;
      }
      // No reservation existed (legacy or direct upload) -> still account for it
      totalSizeBytes += sizeBytes;
      // Optionally insert a confirmed record for audit
      try {
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        await query(
          `INSERT INTO asset_reservations (id, account_id, workspace_id, asset_key, size_bytes, status, expires_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
          [id, accountId, workspaceId || null, assetKey, sizeBytes, 'confirmed', now, now]
        );
      } catch {}
      confirmed++;
    }
  }
  return { confirmed, totalSizeBytes };
}

/**
 * Reap expired pending reservations. Returns deleted count.
 * R2 orphan handling: lazy — blobs uploaded via presign but never confirmed remain in R2 until
 * lifecycle expiry or manual GC. We log the orphan keys for observability; no immediate delete
 * to avoid racing with in-flight uploads near TTL boundary.
 */
async function reapExpiredReservations() {
  // Log orphans before delete (best-effort)
  try {
    const { rows } = await query(`SELECT asset_key, account_id FROM asset_reservations WHERE status='pending' AND expires_at <= NOW() LIMIT 100`);
    if (rows.length > 0) {
      console.log(`[asset-reservations] reaping ${rows.length} expired pending reservations (lazy R2 orphan — blobs remain until lifecycle/manual cleanup)`);
      for (const r of rows.slice(0, 5)) {
        console.log(`[asset-reservations] orphan: account=${r.account_id} key=${r.asset_key}`);
      }
      if (rows.length === 100) console.log('[asset-reservations] ...more expired rows truncated from log');
    }
  } catch {}
  const result = await query(`DELETE FROM asset_reservations WHERE status='pending' AND expires_at <= NOW()`);
  return result.rowCount ?? 0;
}

module.exports = {
  RESERVATION_TTL_SECONDS,
  ASSET_RESERVATION_ADVISORY_KEY,
  hashAccountId,
  reserveForPresign,
  confirmReservations,
  reapExpiredReservations,
  sumPendingForAccount,
  resolveQuotaAndUsed,
};
