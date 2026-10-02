'use strict';

// Account deletion cascades the workspace rows away in Postgres, but the Yjs
// snapshots live in object storage under yjs/<workspaceId>/..., which no collector
// can reach afterwards: yjs-gc enumerates workspaces from the DB, and asset-gc only
// looks under /assets/. So an erasure that leaves them behind is an erasure gap.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');

const repoRoot = path.resolve(__dirname, '..');
process.env.NODE_ENV = 'test';
process.env.JWT_PRIVATE_KEY_PATH = path.join(repoRoot, 'keys/private.pem');
process.env.JWT_PUBLIC_KEY_PATH = path.join(repoRoot, 'keys/public.pem');
process.env.COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars-long';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-characters-long';

const { close, query } = require('../src/db');
const { setupTestDb, cleanTestDb } = require('./helpers/db');
const { seedAccount } = require('./helpers/factory');
const { buildApp } = require('../src/server');
const { createSession } = require('../src/middleware/auth');
const r2 = require('../src/services/r2');
const bcrypt = require('bcrypt');

let origListKeys, origDel;

function stubR2(store) {
  origListKeys = r2.listKeys;
  origDel = r2.del;
  r2.listKeys = async (prefix) => [...store.keys()].filter((k) => k.startsWith(prefix));
  r2.del = async (key) => { store.delete(key); return true; };
}
function restoreR2() {
  if (origListKeys) r2.listKeys = origListKeys;
  if (origDel) r2.del = origDel;
}

test.before(async () => { await setupTestDb(); });
test.after(async () => { restoreR2(); await close(); });

test('deleting an account erases its Yjs snapshots from object storage', async (t) => {
  await cleanTestDb();
  const store = new Map();
  stubR2(store);

  const accountId = 'acct-erase';
  const wsId = 'ws-erase';
  const now = new Date().toISOString();
  await seedAccount(accountId, 'pub-1');
  // DELETE /account re-verifies the password (routes/account.js), so seed one.
  await query('UPDATE accounts SET password_hash=$1 WHERE id=$2',
    [await bcrypt.hash('correct horse battery staple', 12), accountId]);
  await query('INSERT INTO workspaces (id, name_encrypted, owner_id, created_at) VALUES ($1,$2,$3,$4)', [wsId, 'e', accountId, now]);
  await query('INSERT INTO workspace_members (workspace_id, account_id, role, created_at) VALUES ($1,$2,$3,$4)', [wsId, accountId, 'owner', now]);
  await query(
    'INSERT INTO yjs_doc_updates (id, workspace_id, note_id, update_data, update_encrypted, device_id, clock, ts, created_at) VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8)',
    ['u-1', wsId, 'note-1', Buffer.from('aabb', 'hex'), 'dev-a', 1, 1000, now]
  );
  store.set(`${accountId}/commits/c1.json`, 'x');
  store.set(`yjs/${wsId}/note-1/1.yjs`, 'x');

  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const token = await createSession(accountId, { headers: {} });
  const res = await app.inject({
    method: 'DELETE',
    url: '/account',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: { password: 'correct horse battery staple' },
  });
  assert.equal(res.statusCode, 200);

  // The purge runs in setImmediate after the response, so poll rather than guess.
  const deadline = Date.now() + 5000;
  while (store.size > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.deepEqual(
    [...store.keys()].filter((k) => k.startsWith('yjs/')), [],
    'the yjs/ namespace survives account deletion: nothing can reclaim it once the workspace row is gone');
  assert.deepEqual([...store.keys()], [], 'account-owned objects must be purged too');
  t.diagnostic(`account ${accountId} / workspace ${wsId} / ${crypto.randomUUID().slice(0, 6)}`);
});
