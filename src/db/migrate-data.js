'use strict';

const crypto = require('crypto');
const { getDb } = require('./index');

function migrateData() {
  const db = getDb();

  const accounts = db.prepare('SELECT id, username, email_hmac FROM accounts').all();

  for (const account of accounts) {
    const existingOrg = db.prepare(`
      SELECT o.id FROM organizations o
      JOIN org_members om ON o.id = om.org_id
      WHERE om.account_id = ? AND om.role = 'owner'
      LIMIT 1
    `).get(account.id);

    if (existingOrg) continue;

    const orgId = crypto.randomUUID();
    const orgName = account.username || account.email_hmac.slice(0, 8);
    const slug = orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-');

    db.prepare(`
      INSERT INTO organizations (id, name_encrypted, slug, created_at)
      VALUES (?, ?, ?, ?)
    `).run(orgId, orgName, slug, new Date().toISOString());

    db.prepare(`
      INSERT INTO org_members (org_id, account_id, role, created_at)
      VALUES (?, ?, 'owner', ?)
    `).run(orgId, account.id, new Date().toISOString());

    db.prepare(`
      INSERT INTO org_subscriptions (id, org_id, plan, status, seats, created_at)
      VALUES (?, ?, 'free', 'active', 1, ?)
    `).run(crypto.randomUUID(), orgId, new Date().toISOString());

    const workspaces = db.prepare('SELECT id FROM workspaces WHERE owner_id = ?').all(account.id);
    for (const ws of workspaces) {
      db.prepare('UPDATE workspaces SET org_id = ? WHERE id = ?').run(orgId, ws.id);
    }

    const sub = db.prepare('SELECT * FROM subscriptions WHERE account_id = ?').get(account.id);
    if (sub) {
      db.prepare(`
        UPDATE org_subscriptions SET plan = ?, status = ?, storage_quota_bytes = ?
        WHERE org_id = ?
      `).run(sub.plan, sub.status, sub.storage_quota_bytes, orgId);
    }

    console.log(`[migrate] Migrated account ${account.id} -> org ${orgId}`);
  }
}

if (require.main === module) {
  migrateData();
}

module.exports = { migrateData };
