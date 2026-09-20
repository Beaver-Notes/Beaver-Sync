'use strict';

// Forever-behaviour guards for per-device workspace-key envelopes:
//  - any key-holding member (owner/admin/editor) may provision for another
//    member/device; non-members stay denied;
//  - an account's second device gets its own envelope (201 + readable);
//  - legacy account-level rows (device_id NULL) stay readable and are never
//    overwritten; replays never rotate an existing envelope;
//  - /public-keys reports hasEnvelope per (user, device).
//
// The server stores envelopes opaquely and never sees key material.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.NODE_ENV = 'test';
process.env.COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars-long';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-chars-long';
process.env.LEGACY_AUTH_ENABLED = 'true';
process.env.ENTERPRISE_MODE = 'false';

const { query } = require('../src/db');
const { setupTestDb, cleanTestDb } = require('./helpers/db');
const { makeAccount, authHeaders, seedWorkspace } = require('./helpers/factory');
const { buildApp } = require('../src/server');
const { createSession } = require('../src/middleware/auth');

// ML-KEM-768 public keys are 1184 bytes => 2368 hex chars.
function randomKem() {
  return crypto.randomBytes(1184).toString('hex');
}

test.before(async () => {
  await setupTestDb();
  await cleanTestDb();
});

test.after(async () => {
  await cleanTestDb();
});

test('editor (key-holding member) can provision a legacy-shape key; non-member is denied', async (t) => {
  const app = await buildApp();
  t.after(async () => {
    await app.close();
  });

  const ownerId = await makeAccount('ws-owner');
  const editorId = await makeAccount('ws-editor');
  const outsiderId = await makeAccount('ws-outsider');
  const wsId = `ws-${crypto.randomUUID()}`;
  await seedWorkspace(wsId, ownerId);
  await query(
    'INSERT INTO workspace_members (workspace_id, account_id, role, created_at) VALUES ($1,$2,$3,$4)',
    [wsId, editorId, 'editor', new Date().toISOString()]
  );

  const editorHeaders = await authHeaders(editorId);
  const outsiderHeaders = await authHeaders(outsiderId);

  const ok = await app.inject({
    method: 'POST',
    url: `/workspaces/${wsId}/keys`,
    headers: editorHeaders,
    payload: { userId: ownerId, wrappedKey: 'wk-editor-provisioned' },
  });
  assert.equal(ok.statusCode, 201, ok.body);
  assert.equal(ok.json().provisioned, true);

  const denied = await app.inject({
    method: 'POST',
    url: `/workspaces/${wsId}/keys`,
    headers: outsiderHeaders,
    payload: { userId: ownerId, wrappedKey: 'wk-outsider' },
  });
  assert.equal(denied.statusCode, 403, denied.body);

  const { rows } = await query(
    'SELECT wrapped_key FROM workspace_keys WHERE workspace_id = $1 AND user_id = $2',
    [wsId, ownerId]
  );
  assert.equal(rows[0]?.wrapped_key, 'wk-editor-provisioned');
});

test('second device gets its own envelope and can be read back; replay never rotates', async (t) => {
  const app = await buildApp();
  t.after(async () => {
    await app.close();
  });

  const ownerId = await makeAccount('dev-owner');
  const ownerKem = randomKem();
  await query(
    'UPDATE accounts SET kem_public_key = $1, device_keys = $2 WHERE id = $3',
    [ownerKem, JSON.stringify([
      { deviceId: 'dev-a', publicKey: ownerKem },
      { deviceId: 'dev-b', publicKey: randomKem() },
    ]), ownerId]
  );
  const wsId = `ws-${crypto.randomUUID()}`;
  await seedWorkspace(wsId, ownerId);
  const headers = await authHeaders(ownerId);

  // Device A seeds its envelope.
  const first = await app.inject({
    method: 'POST',
    url: `/workspaces/${wsId}/keys`,
    headers,
    payload: { recipients: [{ userId: ownerId, deviceId: 'dev-a', wrappedKey: 'env-a' }] },
  });
  assert.equal(first.statusCode, 201, first.body);
  assert.equal(first.json().stored, 1);

  // public-keys reports dev-b as still missing an envelope.
  const pub1 = await app.inject({ method: 'GET', url: `/workspaces/${wsId}/public-keys`, headers });
  assert.equal(pub1.statusCode, 200, pub1.body);
  const byKey1 = new Map(pub1.json().collaborators.map((c) => [`${c.userId}:${c.deviceId}`, c.hasEnvelope]));
  assert.equal(byKey1.get(`${ownerId}:dev-a`), true);
  assert.equal(byKey1.get(`${ownerId}:dev-b`), false);

  // Key-holder wraps dev-b: the second device now gets a 201.
  const second = await app.inject({
    method: 'POST',
    url: `/workspaces/${wsId}/keys`,
    headers,
    payload: { recipients: [{ userId: ownerId, deviceId: 'dev-b', wrappedKey: 'env-b' }] },
  });
  assert.equal(second.statusCode, 201, second.body);
  assert.equal(second.json().stored, 1);
  assert.equal(second.json().existing, false);

  // Read path: GET /workspaces returns both per-device envelopes.
  const list = await app.inject({ method: 'GET', url: '/workspaces', headers });
  assert.equal(list.statusCode, 200, list.body);
  const ws = list.json().workspaces.find((w) => w.id === wsId);
  const envMap = new Map(ws.wrappedKeys.map((e) => [e.deviceId, e.wrappedKey]));
  assert.equal(envMap.get('dev-a'), 'env-a');
  assert.equal(envMap.get('dev-b'), 'env-b');
  // Unknown device id and no legacy NULL envelope: the scalar is omitted rather
  // than substituted with a foreign device's envelope.
  assert.equal(ws.wrappedKey, null, 'must not expose a foreign device envelope as scalar');

  // A known device id gets its own envelope as the scalar.
  const deviceAHeader = `Bearer ${await createSession(ownerId, { headers: { 'x-device-id': 'dev-a' } })}`;
  const listA = await app.inject({ method: 'GET', url: '/workspaces', headers: { authorization: deviceAHeader } });
  const wsA = listA.json().workspaces.find((w) => w.id === wsId);
  assert.equal(wsA.wrappedKey, 'env-a', 'scalar must be the caller device envelope');

  // Replay for dev-b must not overwrite.
  const replay = await app.inject({
    method: 'POST',
    url: `/workspaces/${wsId}/keys`,
    headers,
    payload: { recipients: [{ userId: ownerId, deviceId: 'dev-b', wrappedKey: 'rotated' }] },
  });
  assert.equal(replay.statusCode, 201, replay.body);
  assert.equal(replay.json().stored, 0);
  assert.equal(replay.json().existing, true);

  const pub2 = await app.inject({ method: 'GET', url: `/workspaces/${wsId}/public-keys`, headers });
  const byKey2 = new Map(pub2.json().collaborators.map((c) => [`${c.userId}:${c.deviceId}`, c.hasEnvelope]));
  assert.equal(byKey2.get(`${ownerId}:dev-b`), true);

  const list2 = await app.inject({ method: 'GET', url: '/workspaces', headers });
  const ws2 = list2.json().workspaces.find((w) => w.id === wsId);
  const envMap2 = new Map(ws2.wrappedKeys.map((e) => [e.deviceId, e.wrappedKey]));
  assert.equal(envMap2.get('dev-b'), 'env-b', 'existing envelope must not rotate');
});

test('legacy NULL-device envelope stays readable and is never overwritten', async (t) => {
  const app = await buildApp();
  t.after(async () => {
    await app.close();
  });

  const ownerId = await makeAccount('legacy-owner');
  const ownerKem = randomKem();
  await query(
    'UPDATE accounts SET kem_public_key = $1, device_keys = $2 WHERE id = $3',
    [ownerKem, JSON.stringify([{ deviceId: 'dev-a', publicKey: ownerKem }]), ownerId]
  );
  const wsId = `ws-${crypto.randomUUID()}`;
  await seedWorkspace(wsId, ownerId);
  const headers = await authHeaders(ownerId);

  await query(
    'INSERT INTO workspace_keys (workspace_id, user_id, device_id, wrapped_key, created_at) VALUES ($1,$2,NULL,$3,$4)',
    [wsId, ownerId, 'legacy-envelope', new Date().toISOString()]
  );

  const list = await app.inject({ method: 'GET', url: '/workspaces', headers });
  const ws = list.json().workspaces.find((w) => w.id === wsId);
  const legacy = (ws.wrappedKeys || []).find((e) => e.deviceId == null);
  assert.equal(legacy?.wrappedKey, 'legacy-envelope', 'legacy account-level envelope must stay readable');
  // Unknown device id: the legacy account-level envelope is the scalar.
  assert.equal(ws.wrappedKey, 'legacy-envelope', 'legacy envelope must back the scalar for device-less callers');

  // A legacy row does not count as an envelope for any specific device.
  const pub = await app.inject({ method: 'GET', url: `/workspaces/${wsId}/public-keys`, headers });
  const byKey = new Map(pub.json().collaborators.map((c) => [`${c.userId}:${c.deviceId}`, c.hasEnvelope]));
  assert.equal(byKey.get(`${ownerId}:dev-a`), false);

  // Provisioning dev-a adds a row; the legacy row is untouched.
  const res = await app.inject({
    method: 'POST',
    url: `/workspaces/${wsId}/keys`,
    headers,
    payload: { recipients: [{ userId: ownerId, deviceId: 'dev-a', wrappedKey: 'env-a' }] },
  });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().stored, 1);

  const { rows } = await query(
    'SELECT wrapped_key FROM workspace_keys WHERE workspace_id = $1 AND user_id = $2 AND device_id IS NULL',
    [wsId, ownerId]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].wrapped_key, 'legacy-envelope', 'legacy envelope must never be overwritten');
});

test('a member who does not hold the workspace key cannot provision an envelope', async (t) => {
  const app = await buildApp();
  t.after(async () => {
    await app.close();
  });

  const ownerId = await makeAccount('hold-owner');
  const editorId = await makeAccount('hold-editor');
  const wsId = `ws-${crypto.randomUUID()}`;
  await seedWorkspace(wsId, ownerId);
  await query(
    'INSERT INTO workspace_members (workspace_id, account_id, role, created_at) VALUES ($1,$2,$3,$4)',
    [wsId, editorId, 'editor', new Date().toISOString()]
  );

  const ownerHeaders = await authHeaders(ownerId);
  const editorHeaders = await authHeaders(editorId);

  // First provisioner on a keyless workspace seeds the key (owner).
  const seed = await app.inject({
    method: 'POST',
    url: `/workspaces/${wsId}/keys`,
    headers: ownerHeaders,
    payload: { recipients: [{ userId: ownerId, deviceId: 'default', wrappedKey: 'wk-owner' }] },
  });
  assert.equal(seed.statusCode, 201, seed.body);

  // The editor is a member but holds no envelope: it must not be able to inject
  // an arbitrary (garbage) envelope that the device would then be stuck with.
  const denied = await app.inject({
    method: 'POST',
    url: `/workspaces/${wsId}/keys`,
    headers: editorHeaders,
    payload: { recipients: [{ userId: editorId, deviceId: 'default', wrappedKey: 'garbage' }] },
  });
  assert.equal(denied.statusCode, 403, denied.body);
  const { rows: afterDenied } = await query(
    'SELECT COUNT(*)::int AS c FROM workspace_keys WHERE workspace_id = $1 AND user_id = $2',
    [wsId, editorId]
  );
  assert.equal(afterDenied[0].c, 0, 'a non-holder must not store an envelope');

  // A key-holding member can still wrap the key for the missing device.
  const ok = await app.inject({
    method: 'POST',
    url: `/workspaces/${wsId}/keys`,
    headers: ownerHeaders,
    payload: { recipients: [{ userId: editorId, deviceId: 'default', wrappedKey: 'wk-editor' }] },
  });
  assert.equal(ok.statusCode, 201, ok.body);
  assert.equal(ok.json().stored, 1, 'the legitimate wrap-for-others flow must still work');
});

test('removing a workspace member deletes every device envelope', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const ownerId = await makeAccount('rm-owner');
  const editorId = await makeAccount('rm-editor');
  const wsId = `ws-${crypto.randomUUID()}`;
  await seedWorkspace(wsId, ownerId);
  await query(
    'INSERT INTO workspace_members (workspace_id, account_id, role, created_at) VALUES ($1,$2,$3,$4)',
    [wsId, editorId, 'editor', new Date().toISOString()]
  );
  const now = new Date().toISOString();
  for (const [userId, deviceId] of [[ownerId, 'default'], [editorId, 'dev-a'], [editorId, 'dev-b']]) {
    await query(
      'INSERT INTO workspace_keys (workspace_id, user_id, device_id, wrapped_key, created_at) VALUES ($1,$2,$3,$4,$5)',
      [wsId, userId, deviceId, `wk-${deviceId}`, now]
    );
  }

  const headers = await authHeaders(ownerId);
  const res = await app.inject({ method: 'DELETE', url: `/workspaces/${wsId}/members/${editorId}`, headers });
  assert.equal(res.statusCode, 200, res.body);

  const { rows } = await query(
    'SELECT device_id FROM workspace_keys WHERE workspace_id = $1 AND user_id = $2',
    [wsId, editorId]
  );
  assert.equal(rows.length, 0, 'all of the removed member\'s device envelopes must be deleted');

  const ownerRows = await query('SELECT COUNT(*)::int AS c FROM workspace_keys WHERE workspace_id = $1 AND user_id = $2', [wsId, ownerId]);
  assert.equal(ownerRows.rows[0].c, 1, 'other members\' envelopes must be untouched');
});

test('members reports per-device envelope presence, not an account-level flag', async (t) => {
  const app = await buildApp();
  t.after(async () => {
    await app.close();
  });

  const ownerId = await makeAccount('mem-owner');
  const editorId = await makeAccount('mem-editor');
  const ownerKem = randomKem();
  await query(
    'UPDATE accounts SET kem_public_key = $1, device_keys = $2 WHERE id = $3',
    [ownerKem, JSON.stringify([
      { deviceId: 'dev-a', publicKey: ownerKem },
      { deviceId: 'dev-b', publicKey: randomKem() },
    ]), ownerId]
  );
  const wsId = `ws-${crypto.randomUUID()}`;
  await seedWorkspace(wsId, ownerId);
  await query(
    'INSERT INTO workspace_members (workspace_id, account_id, role, created_at) VALUES ($1,$2,$3,$4)',
    [wsId, editorId, 'editor', new Date().toISOString()]
  );

  // Owner's dev-a and the editor's default device hold envelopes; owner's dev-b
  // does not.
  const ownerHeaders = await authHeaders(ownerId);
  for (const recipients of [
    [{ userId: ownerId, deviceId: 'dev-a', wrappedKey: 'env-a' }],
    [{ userId: editorId, deviceId: 'default', wrappedKey: 'env-ed' }],
  ]) {
    const res = await app.inject({
      method: 'POST',
      url: `/workspaces/${wsId}/keys`,
      headers: ownerHeaders,
      payload: { recipients },
    });
    assert.equal(res.statusCode, 201, res.body);
  }

  const deviceAHeaders = {
    authorization: `Bearer ${await createSession(ownerId, { headers: { 'x-device-id': 'dev-a' } })}`,
  };
  const res = await app.inject({ method: 'GET', url: `/workspaces/${wsId}/members`, headers: deviceAHeaders });
  assert.equal(res.statusCode, 200, res.body);
  const byUser = new Map(res.json().members.map((m) => [m.userId, m]));

  const ownerMember = byUser.get(ownerId);
  assert.deepEqual(ownerMember.devices, [
    { deviceId: 'dev-a', hasEnvelope: true },
    { deviceId: 'dev-b', hasEnvelope: false },
  ]);
  assert.equal(ownerMember.hasWrappedKey, true, "own dev-a envelope is present");

  const editorMember = byUser.get(editorId);
  assert.deepEqual(editorMember.devices, [{ deviceId: 'default', hasEnvelope: true }]);
  // The old account-level flag was true whenever ANY envelope existed; per-device
  // truth is false here because this caller's device (dev-a) has no envelope.
  assert.equal(editorMember.hasWrappedKey, false, 'a default-device envelope is not a dev-a envelope');
});
