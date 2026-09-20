'use strict';

// Phase 2 — one vault key per account.
//
// The account-scoped row is adopted from the OLDEST per-workspace
// `vault_key_params` row the account itself published (the workspace it created
// first). Adoption is:
//   * deterministic — same row every time,
//   * idempotent   — a second call returns the same row,
//   * non-destructive — per-workspace rows are only read, never deleted or
//     rewritten, so old clients and already-sealed workspace data keep working.

const crypto = require('crypto');
const { query } = require('../db');

const SELECT_COLUMNS = 'id, account_id, owner_id, key_params_blob, created_at, updated_at';

async function getAccountVaultKeyParams(accountId) {
  const { rows } = await query(
    `SELECT ${SELECT_COLUMNS} FROM account_vault_key_params WHERE account_id = $1`,
    [accountId]
  );
  return rows[0] ?? null;
}

// Adopt the account's oldest published params into the account scope. Returns
// the adopted row, or null when the account has never published per-workspace
// params. Selecting only its OWN rows (owner_id = account) means a workspace the
// account merely belongs to can never seed its account vault.
async function adoptAccountVaultKeyParams(accountId) {
  const existing = await getAccountVaultKeyParams(accountId);
  if (existing) return existing;

  const { rows } = await query(
    `SELECT owner_id, key_params_blob
       FROM vault_key_params
      WHERE owner_id = $1
      ORDER BY created_at ASC, id ASC
      LIMIT 1`,
    [accountId]
  );
  const source = rows[0];
  if (!source) return null;

  const now = new Date().toISOString();
  await query(
    `INSERT INTO account_vault_key_params
       (id, account_id, owner_id, key_params_blob, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (account_id) DO NOTHING`,
    [crypto.randomUUID(), accountId, source.owner_id, source.key_params_blob, now, now]
  );
  return getAccountVaultKeyParams(accountId);
}

// Publish this account's own local key params. Never rewrites an existing
// account vault to a different blob (returns null so the route can 409);
// republishing the identical blob is idempotent.
async function publishAccountVaultKeyParams(accountId, ownerId, keyParamsBlob) {
  const existing = await getAccountVaultKeyParams(accountId);
  if (existing) {
    return existing.key_params_blob === keyParamsBlob ? existing : null;
  }

  const now = new Date().toISOString();
  await query(
    `INSERT INTO account_vault_key_params
       (id, account_id, owner_id, key_params_blob, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (account_id) DO NOTHING`,
    [crypto.randomUUID(), accountId, ownerId, keyParamsBlob, now, now]
  );
  return getAccountVaultKeyParams(accountId);
}

module.exports = {
  getAccountVaultKeyParams,
  adoptAccountVaultKeyParams,
  publishAccountVaultKeyParams,
};
