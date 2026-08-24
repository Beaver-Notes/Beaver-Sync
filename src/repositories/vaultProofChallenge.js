'use strict';

const crypto = require('crypto');
const { query, transaction } = require('../db');

function hashChallenge(challenge) {
  return crypto.createHash('sha256').update(challenge, 'utf8').digest('hex');
}

async function createVaultChallenge({ workspaceId, accountId, challenge, expiresAt, createdAt }) {
  await query(
    'INSERT INTO vault_proof_challenges (id, workspace_id, account_id, challenge_hash, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [crypto.randomUUID(), workspaceId, accountId, hashChallenge(challenge), expiresAt, createdAt]
  );
}

async function consumeVaultChallenge({ workspaceId, accountId, challenge }) {
  const now = new Date().toISOString();
  return transaction(async (client) => {
    const { rows } = await client.query(
      'SELECT id, expires_at FROM vault_proof_challenges WHERE workspace_id = $1 AND account_id = $2 AND challenge_hash = $3 LIMIT 1',
      [workspaceId, accountId, hashChallenge(challenge)]
    );
    const row = rows[0];
    if (!row || row.expires_at <= now) {
      if (row) await client.query('DELETE FROM vault_proof_challenges WHERE id = $1', [row.id]);
      return false;
    }
    const result = await client.query('DELETE FROM vault_proof_challenges WHERE id = $1', [row.id]);
    return result.rowCount === 1;
  });
}

module.exports = { createVaultChallenge, consumeVaultChallenge };
