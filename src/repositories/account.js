'use strict';

const { transaction } = require('../db');
const { Account } = require('../models');

// Usernames are display labels and intentionally not unique (migrate-postgres
// drops the legacy UNIQUE constraint), but using one to resolve an invite would
// pick an arbitrary account. Detect the ambiguity so callers can ask for email.
async function findAccountByUsername(username) {
  const matches = await Account.find({ username }).limit(2).lean();
  if (matches.length === 0) return { account: null, ambiguous: false };
  if (matches.length > 1) return { account: null, ambiguous: true };
  return { account: matches[0], ambiguous: false };
}

async function deleteAccountData({ userId, accountIdHash }) {
  await transaction(async (client) => {
    await client.query(`DELETE FROM audit_logs WHERE account_id_hash = $1`, [accountIdHash]);

    // Capture owned org IDs BEFORE deleting org_members, since subsequent
    // deletes reference org_members to find which orgs the account owns.
    const { rows: ownedOrgs } = await client.query(
      `SELECT org_id FROM org_members WHERE account_id = $1 AND role = 'owner'`,
      [userId]
    );
    const ownedOrgIds = ownedOrgs.map((r) => r.org_id);

    await client.query(`DELETE FROM org_members WHERE account_id = $1`, [userId]);

    if (ownedOrgIds.length > 0) {
      const orgPlaceholders = ownedOrgIds.map((_, i) => `$${i + 1}`).join(', ');
      await client.query(
        `DELETE FROM org_subscriptions WHERE org_id IN (${orgPlaceholders})`,
        ownedOrgIds
      );
      await client.query(
        `DELETE FROM workspaces WHERE org_id IN (${orgPlaceholders})`,
        ownedOrgIds
      );
      await client.query(
        `DELETE FROM organizations WHERE id IN (${orgPlaceholders})`,
        ownedOrgIds
      );
    }

    await client.query(`DELETE FROM accounts WHERE id = $1`, [userId]);
  });
}

module.exports = { deleteAccountData, findAccountByUsername };
