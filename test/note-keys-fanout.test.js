'use strict';

// TDD test for Task 2: per-device `note_keys` envelopes + fan-out public keys.
//
// NOTE: The upstream brief assumed a `vitest` runner plus `test/helpers.js`
// and `test/fixtures.js` (seedNoteWithCollaborator/makeEnvelope/OWNER_ID/
// COLLAB_ID/app) which do NOT exist in this repo. This repo uses `node --test`
// (no vitest) with the real harness (`buildApp`, `setupTestDb`, `createSession`)
// and the real `/collaboration` route prefix. Those helpers are built here
// inline using the same pattern as Task 1's device-keys test.
//
// Behavioral assertions preserved from the brief:
//   1. storeRecipients stores per-device envelopes for a user, and getKey
//      returns all of the caller's device envelopes (noteHasKey: true).
//   2. listPublicKeys returns one flat entry per collaborator device
//      ({ userId, deviceId, kemPublicKey }).
// Plus: a fresh note reports { noteHasKey: false } (correction #1).

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
const { makeAccount, authHeaders } = require('./helpers/factory');
const { buildApp } = require('../src/server');

// ML-KEM-768 public keys are 1184 bytes => 2368 hex chars.
function randomKem() {
  return crypto.randomBytes(1184).toString('hex');
}

// A wrapped key envelope — opaque to the server, so any non-empty string works.
function makeEnvelope(name) {
  return `wk-${name}-${crypto.randomBytes(16).toString('hex')}`;
}

async function seedNoteWithCollaborator(opts = {}) {
  const ownerId = await makeAccount('owner');
  const collabId = await makeAccount('collab');
  const ownerKem = randomKem();
  const collabKem = randomKem();
  await query('UPDATE accounts SET kem_public_key = $1 WHERE id = $2', [ownerKem, ownerId]);
  await query('UPDATE accounts SET kem_public_key = $1 WHERE id = $2', [collabKem, collabId]);

  if (opts.devices && opts.devices.length) {
    const deviceKeys = opts.devices.map((d, i) => ({
      deviceId: d,
      publicKey: i === 0 ? collabKem : randomKem(),
    }));
    await query('UPDATE accounts SET device_keys = $1 WHERE id = $2', [JSON.stringify(deviceKeys), collabId]);
  }

  const noteId = `note-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await query(
    'INSERT INTO note_invitations (note_id, user_id, invited_by, role, created_at) VALUES ($1,$2,$2,$3,$4),($1,$5,$2,$3,$4)',
    [noteId, ownerId, 'editor', now, collabId]
  );

  return {
    noteId,
    ownerHeaders: await authHeaders(ownerId),
    collabHeaders: await authHeaders(collabId),
    ownerId,
    collabId,
  };
}

test.before(async () => {
  await setupTestDb();
  await cleanTestDb();
});

test.after(async () => {
  await cleanTestDb();
});

test('storeRecipients stores per-device envelopes and getKey returns all', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const { noteId, ownerHeaders, ownerId } = await seedNoteWithCollaborator();
  const wrappedA = makeEnvelope('kA');
  const wrappedB = makeEnvelope('kB');
  const store = await app.inject({
    method: 'POST',
    url: `/collaboration/keys/${noteId}/recipients`,
    headers: ownerHeaders,
    payload: {
      recipients: [
        { userId: ownerId, deviceId: 'dev-a', wrappedKey: wrappedA },
        { userId: ownerId, deviceId: 'dev-b', wrappedKey: wrappedB },
      ],
    },
  });
  assert.equal(store.statusCode, 200, `store failed: ${store.body}`);
  assert.equal(store.json().stored, 2);

  const res = await app.inject({
    method: 'GET',
    url: `/collaboration/keys/${noteId}`,
    headers: ownerHeaders,
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.noteHasKey, true);
  assert.equal(body.wrappedKeys.length, 2);
  assert.deepEqual(body.wrappedKeys.map((w) => w.deviceId).sort(), ['dev-a', 'dev-b']);
  const map = new Map(body.wrappedKeys.map((w) => [w.deviceId, w.wrappedKey]));
  assert.equal(map.get('dev-a'), wrappedA);
  assert.equal(map.get('dev-b'), wrappedB);
});

test('getKey reports noteHasKey false for a fresh note', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const { noteId, ownerHeaders } = await seedNoteWithCollaborator();
  const res = await app.inject({
    method: 'GET',
    url: `/collaboration/keys/${noteId}`,
    headers: ownerHeaders,
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.noteHasKey, false);
  assert.deepEqual(body.wrappedKeys, []);
});

test('listPublicKeys returns all device keys of collaborators (flat shape)', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const { noteId, ownerHeaders, collabId } = await seedNoteWithCollaborator({ devices: ['d1', 'd2'] });
  const res = await app.inject({
    method: 'GET',
    url: `/collaboration/public-keys/${noteId}`,
    headers: ownerHeaders,
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.ok(Array.isArray(body.collaborators), 'collaborators must be an array');

  const collabEntries = body.collaborators.filter((c) => c.userId === collabId);
  assert.equal(collabEntries.length, 2, 'collaborator should expose both device keys');
  assert.deepEqual(collabEntries.map((c) => c.deviceId).sort(), ['d1', 'd2']);
  for (const c of collabEntries) {
    assert.ok(typeof c.kemPublicKey === 'string' && c.kemPublicKey.length === 2368, 'kemPublicKey must be valid-length hex');
  }
});

test('a late joiner gets an add-only envelope and existing keys never rotate', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const { noteId, ownerHeaders, collabHeaders, ownerId, collabId } =
    await seedNoteWithCollaborator({ devices: ['collab-1'] });
  const wrap = (name) => makeEnvelope(name);
  const ownerEnv = wrap('owner');

  // Owner seeds the note key (first writer wins). The owner has no explicit
  // deviceKeys, so the server treats them as the `default` device.
  const first = await app.inject({
    method: 'POST',
    url: `/collaboration/keys/${noteId}/recipients`,
    headers: ownerHeaders,
    payload: { recipients: [{ userId: ownerId, deviceId: 'default', wrappedKey: ownerEnv }] },
  });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().stored, 1);
  assert.equal(first.json().existing, false);

  // A later collaborator is wrapped for their device without rotating the key.
  const late = await app.inject({
    method: 'POST',
    url: `/collaboration/keys/${noteId}/recipients`,
    headers: ownerHeaders,
    payload: { recipients: [{ userId: collabId, deviceId: 'collab-1', wrappedKey: wrap('collab') }] },
  });
  assert.equal(late.statusCode, 200, late.body);
  assert.equal(late.json().stored, 1, 'the new device envelope must be stored');
  assert.equal(late.json().existing, false);

  const collabKeys = await app.inject({
    method: 'GET',
    url: `/collaboration/keys/${noteId}`,
    headers: collabHeaders,
  });
  assert.equal(collabKeys.statusCode, 200, collabKeys.body);
  assert.equal(collabKeys.json().wrappedKeys.length, 1);
  assert.equal(collabKeys.json().wrappedKeys[0].deviceId, 'collab-1');

  // Re-posting an existing recipient must not overwrite (no key rotation).
  const replay = await app.inject({
    method: 'POST',
    url: `/collaboration/keys/${noteId}/recipients`,
    headers: ownerHeaders,
    payload: { recipients: [{ userId: ownerId, deviceId: 'default', wrappedKey: wrap('rotated') }] },
  });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().stored, 0);
  assert.equal(replay.json().existing, true);

  const ownerKeys = await app.inject({
    method: 'GET',
    url: `/collaboration/keys/${noteId}`,
    headers: ownerHeaders,
  });
  assert.equal(ownerKeys.json().wrappedKeys[0].wrappedKey, ownerEnv, 'existing envelope must not rotate');

  // public-keys flags which devices still need an envelope.
  const pub = await app.inject({
    method: 'GET',
    url: `/collaboration/public-keys/${noteId}`,
    headers: ownerHeaders,
  });
  assert.equal(pub.statusCode, 200, pub.body);
  const byKey = new Map(pub.json().collaborators.map((c) => [`${c.userId}:${c.deviceId}`, c.hasEnvelope]));
  assert.equal(byKey.get(`${ownerId}:default`), true);
  assert.equal(byKey.get(`${collabId}:collab-1`), true);
});

test('removing a note collaborator deletes every device envelope', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const { noteId, ownerHeaders, ownerId, collabId } = await seedNoteWithCollaborator({ devices: ['d1', 'd2'] });
  const now = new Date().toISOString();
  for (const [userId, deviceId] of [[ownerId, 'default'], [collabId, 'd1'], [collabId, 'd2']]) {
    await query(
      'INSERT INTO note_keys (note_id, user_id, device_id, wrapped_key, created_at) VALUES ($1,$2,$3,$4,$5)',
      [noteId, userId, deviceId, `wk-${deviceId}`, now]
    );
  }

  const res = await app.inject({
    method: 'DELETE',
    url: `/collaboration/invite/${noteId}/${collabId}`,
    headers: ownerHeaders,
  });
  assert.equal(res.statusCode, 200, res.body);

  const { rows } = await query(
    'SELECT device_id FROM note_keys WHERE note_id = $1 AND user_id = $2',
    [noteId, collabId]
  );
  assert.equal(rows.length, 0, 'all of the removed user\'s device envelopes must be deleted');

  const ownerRows = await query('SELECT COUNT(*)::int AS c FROM note_keys WHERE note_id = $1 AND user_id = $2', [noteId, ownerId]);
  assert.equal(ownerRows.rows[0].c, 1, 'other collaborators\' envelopes must be untouched');
});

// L8: rotation replaces every envelope for the note under a new generation. The
// caller must hold a key, the removed user's devices lose their envelope, a
// stale envelope cannot be replayed, and unrelated collaborators keep theirs.
async function seedRotationNote() {
  const ownerId = await makeAccount('rot-owner');
  const keepId = await makeAccount('rot-keep');
  const removedId = await makeAccount('rot-removed');
  const keylessId = await makeAccount('rot-keyless');
  for (const [id, ch] of [[ownerId, 'a'], [keepId, 'b'], [removedId, 'c'], [keylessId, 'd']]) {
    await query('UPDATE accounts SET kem_public_key = $1 WHERE id = $2', [ch.repeat(2368), id]);
  }

  const noteId = `note-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  for (const uid of [ownerId, keepId, removedId, keylessId]) {
    await query(
      'INSERT INTO note_invitations (note_id,user_id,invited_by,role,created_at) VALUES ($1,$2,$2,$3,$4)',
      [noteId, uid, 'editor', now]
    );
  }
  // owner, keep and removed hold envelopes; keyless deliberately does not.
  for (const [uid, dev, wk] of [
    [ownerId, 'default', 'wk-owner-old'],
    [keepId, 'keep-dev', 'wk-keep-old'],
    [removedId, 'rem-dev', 'wk-removed'],
  ]) {
    await query(
      'INSERT INTO note_keys (note_id,user_id,device_id,wrapped_key,created_at) VALUES ($1,$2,$3,$4,$5)',
      [noteId, uid, dev, wk, now]
    );
  }

  return {
    noteId,
    ownerId,
    keepId,
    removedId,
    keylessId,
    ownerHeaders: await authHeaders(ownerId),
    keepHeaders: await authHeaders(keepId),
    removedHeaders: await authHeaders(removedId),
    keylessHeaders: await authHeaders(keylessId),
  };
}

test('rotation requires the caller to hold a note-key envelope', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const { noteId, ownerId, keylessHeaders } = await seedRotationNote();
  const res = await app.inject({
    method: 'POST',
    url: `/collaboration/keys/${noteId}/rotate`,
    headers: keylessHeaders,
    payload: { recipients: [{ userId: ownerId, deviceId: 'default', wrappedKey: 'wk-forged' }] },
  });
  assert.equal(res.statusCode, 403, res.body);
  assert.equal(res.json().error, 'forbidden');

  // The keyless collaborator could not replace the key-holder's envelope.
  const ownerRow = await query(
    'SELECT wrapped_key FROM note_keys WHERE note_id = $1 AND user_id = $2',
    [noteId, ownerId]
  );
  assert.equal(ownerRow.rows[0].wrapped_key, 'wk-owner-old');
});

test('rotation replaces envelopes, drops the removed user, and bumps generation', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const { noteId, ownerId, keepId, removedId, removedHeaders, ownerHeaders, keepHeaders } =
    await seedRotationNote();

  // Remove the collaborator first (deletes their invitation and envelopes).
  const removed = await app.inject({
    method: 'DELETE',
    url: `/collaboration/invite/${noteId}/${removedId}`,
    headers: ownerHeaders,
  });
  assert.equal(removed.statusCode, 200, removed.body);

  // The owner rotates and re-wraps the remaining collaborators only.
  const rotate = await app.inject({
    method: 'POST',
    url: `/collaboration/keys/${noteId}/rotate`,
    headers: ownerHeaders,
    payload: {
      recipients: [
        { userId: ownerId, deviceId: 'default', wrappedKey: 'wk-owner-new' },
        { userId: keepId, deviceId: 'keep-dev', wrappedKey: 'wk-keep-new' },
      ],
    },
  });
  assert.equal(rotate.statusCode, 200, rotate.body);
  assert.equal(rotate.json().stored, 2);
  assert.equal(rotate.json().generation, 1, 'the new generation is recorded');

  const rows = await query(
    'SELECT user_id, device_id, wrapped_key, generation FROM note_keys WHERE note_id = $1 ORDER BY user_id',
    [noteId]
  );
  assert.equal(rows.rows.length, 2, 'only the remaining collaborators hold envelopes');
  const byUser = new Map(rows.rows.map((r) => [r.user_id, r]));
  assert.equal(byUser.has(removedId), false, 'the removed user has no envelope');
  assert.equal(byUser.get(ownerId).wrapped_key, 'wk-owner-new');
  assert.equal(byUser.get(keepId).wrapped_key, 'wk-keep-new', 'unrelated collaborator keeps an envelope');
  for (const r of rows.rows) {
    assert.equal(Number(r.generation), 1, 'every new envelope carries the new generation');
  }

  // A stale (pre-rotation) envelope from the removed user cannot be replayed:
  // they are no longer a collaborator, so both the add-only and rotate paths
  // refuse, and their old envelope stays deleted.
  const replayAdd = await app.inject({
    method: 'POST',
    url: `/collaboration/keys/${noteId}/recipients`,
    headers: removedHeaders,
    payload: { recipients: [{ userId: removedId, deviceId: 'rem-dev', wrappedKey: 'wk-removed' }] },
  });
  assert.equal(replayAdd.statusCode, 403, replayAdd.body);
  const replayRotate = await app.inject({
    method: 'POST',
    url: `/collaboration/keys/${noteId}/rotate`,
    headers: removedHeaders,
    payload: { recipients: [{ userId: removedId, deviceId: 'rem-dev', wrappedKey: 'wk-removed' }] },
  });
  assert.equal(replayRotate.statusCode, 403, replayRotate.body);

  const removedRows = await query(
    'SELECT device_id FROM note_keys WHERE note_id = $1 AND user_id = $2',
    [noteId, removedId]
  );
  assert.equal(removedRows.rows.length, 0, 'a stale envelope cannot be replayed back in');

  // A remaining collaborator still fetches a usable envelope.
  const keepKeys = await app.inject({
    method: 'GET',
    url: `/collaboration/keys/${noteId}`,
    headers: keepHeaders,
  });
  assert.equal(keepKeys.statusCode, 200, keepKeys.body);
  assert.equal(keepKeys.json().wrappedKeys[0].wrappedKey, 'wk-keep-new');
});

test('bootstrap requires note ownership and only one collaborator wins', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const ownerId = await makeAccount('bs-owner');
  const editorId = await makeAccount('bs-editor');
  const outsiderId = await makeAccount('bs-outsider');
  await query('UPDATE accounts SET kem_public_key = $1 WHERE id = $2', ['a'.repeat(2368), ownerId]);
  await query('UPDATE accounts SET kem_public_key = $1 WHERE id = $2', ['b'.repeat(2368), editorId]);
  await query('UPDATE accounts SET kem_public_key = $1 WHERE id = $2', ['c'.repeat(2368), outsiderId]);

  const now = new Date().toISOString();
  const workspaceId = `ws-${crypto.randomUUID()}`;
  await query('INSERT INTO workspaces (id, name_encrypted, owner_id, created_at) VALUES ($1, $2, $3, $4)', [workspaceId, 'e', ownerId, now]);
  await query('INSERT INTO workspace_members (workspace_id, account_id, role, created_at) VALUES ($1, $2, \'owner\', $3)', [workspaceId, ownerId, now]);
  await query('INSERT INTO workspace_members (workspace_id, account_id, role, created_at) VALUES ($1, $2, \'editor\', $3)', [workspaceId, editorId, now]);

  const noteId = `note-${crypto.randomUUID()}`;
  await query(
    `INSERT INTO sync_document_state (workspace_id, note_id, snapshot_generation, snapshot_key, checkpoint_ts, checkpoint_sequence, updated_at)
     VALUES ($1, $2, 0, '', 0, 0, $3) ON CONFLICT DO NOTHING`,
    [workspaceId, noteId, now]
  );

  // A stranger who knows the noteId but has no workspace claim is refused.
  const outsider = await app.inject({
    method: 'POST', url: `/collaboration/keys/${noteId}`, headers: await authHeaders(outsiderId),
  });
  assert.equal(outsider.statusCode, 403);
  assert.equal(outsider.json().error, 'note_ownership_required');

  // Two legitimate owners race the claim: exactly one becomes a collaborator.
  const [a, b] = await Promise.all([
    app.inject({ method: 'POST', url: `/collaboration/keys/${noteId}`, headers: await authHeaders(ownerId) }),
    app.inject({ method: 'POST', url: `/collaboration/keys/${noteId}`, headers: await authHeaders(editorId) }),
  ]);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 403]);

  const { rows } = await query('SELECT COUNT(*)::int AS c FROM note_invitations WHERE note_id = $1', [noteId]);
  assert.equal(rows[0].c, 1);
});
