'use strict';

const { transaction } = require('../db');

async function deleteAccountData({ userId, accountIdHash }) {
  await transaction(async (client) => {
    await client.query(`DELETE FROM audit_logs WHERE account_id_hash = $1`, [accountIdHash]);

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

module.exports = { deleteAccountData };
