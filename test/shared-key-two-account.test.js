'use strict';

// End-to-end, two-ACCOUNT (not two devices of one account) integration test for
// the per-note collaboration ("shared key") design.
//
// It drives the real HTTP surface against the live Postgres/MinIO test
// containers:
//   * A creates a workspace; B joins it through the invite/join API.
//   * A publishes a note's per-note key as per-DEVICE ML-KEM-768 envelopes and
//     the workspace key as per-device envelopes.
//   * B sees hasEnvelope:false, cannot self-provision (no key rotation), is
//     wrapped by A, then fetches and unwraps its own envelope with its ML-KEM
//     secret key.
//   * B seals a Yjs update under the shared note key (v6 envelope); A pulls the
//     exact envelope back and decrypts the plaintext with the shared key.
//   * Both accounts see the same commit history; a non-member cannot.
//   * A workspace-scoped asset is stored v6/opaque; the server never holds
//     plaintext.
//
// Envelope crypto is REPLICATED in this file (XChaCha20-Poly1305 via HChaCha20
// + Node's chacha20-poly1305), because the server has no XChaCha20 primitive and
// the producer is the Rust client. The HChaCha20 known-answer vector below
// pins the replication to the real algorithm; cross-language interop is proven
// by the Rust unit tests, not here (see the report).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');

process.env.NODE_ENV = 'test';
process.env.JWT_PRIVATE_KEY_PATH = path.join(repoRoot, 'keys/private.pem');
process.env.JWT_PUBLIC_KEY_PATH = path.join(repoRoot, 'keys/public.pem');
process.env.COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars-long';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-chars-long';
process.env.LEGACY_AUTH_ENABLED = 'true';
process.env.ENTERPRISE_MODE = 'false';

const { close, query } = require('../src/db');
const { setupTestDb, cleanTestDb } = require('./helpers/db');
const { register, authHeaders } = require('./helpers/factory');
const { buildApp } = require('../src/server');
const { createSession } = require('../src/middleware/auth');
const { createMlKem768 } = require('mlkem');
const { wrapForRecipient, unwrapForRecipient } = require('../src/lib/recipient-wrap');
const { decodeAssetKey } = require('../src/routes/assets-shared');

// XChaCha20-Poly1305 (server-side replication of the Rust client primitive).

function rotl32(v, c) {
  return ((v << c) | (v >>> (32 - c))) >>> 0;
}

function quarterRound(s, a, b, c, d) {
  s[a] = (s[a] + s[b]) >>> 0; s[d] ^= s[a]; s[d] = rotl32(s[d], 16);
  s[c] = (s[c] + s[d]) >>> 0; s[b] ^= s[c]; s[b] = rotl32(s[b], 12);
  s[a] = (s[a] + s[b]) >>> 0; s[d] ^= s[a]; s[d] = rotl32(s[d], 8);
  s[c] = (s[c] + s[d]) >>> 0; s[b] ^= s[c]; s[b] = rotl32(s[b], 7);
}

function hchacha20(key, nonce16) {
  const s = new Uint32Array(16);
  s[0] = 0x61707865; s[1] = 0x3320646e; s[2] = 0x79622d32; s[3] = 0x6b206574;
  for (let i = 0; i < 8; i++) s[4 + i] = key.readUInt32LE(i * 4);
  for (let i = 0; i < 4; i++) s[12 + i] = nonce16.readUInt32LE(i * 4);
  for (let i = 0; i < 10; i++) {
    quarterRound(s, 0, 4, 8, 12); quarterRound(s, 1, 5, 9, 13);
    quarterRound(s, 2, 6, 10, 14); quarterRound(s, 3, 7, 11, 15);
    quarterRound(s, 0, 5, 10, 15); quarterRound(s, 1, 6, 11, 12);
    quarterRound(s, 2, 7, 8, 13); quarterRound(s, 3, 4, 9, 14);
  }
  const out = Buffer.alloc(32);
  for (const [i, w] of [0, 1, 2, 3].entries()) out.writeUInt32LE(s[w], i * 4);
  for (const [i, w] of [12, 13, 14, 15].entries()) out.writeUInt32LE(s[w], 16 + i * 4);
  return out;
}

function xchachaEncrypt(key32, nonce24, plaintext, aad) {
  const subkey = hchacha20(key32, nonce24.subarray(0, 16));
  const nonce12 = Buffer.concat([Buffer.alloc(4), nonce24.subarray(16, 24)]);
  const cipher = crypto.createCipheriv('chacha20-poly1305', subkey, nonce12, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([ciphertext, cipher.getAuthTag()]);
}

function xchachaDecrypt(key32, nonce24, blob, aad) {
  const subkey = hchacha20(key32, nonce24.subarray(0, 16));
  const nonce12 = Buffer.concat([Buffer.alloc(4), nonce24.subarray(16, 24)]);
  const tag = blob.subarray(blob.length - 16);
  const ciphertext = blob.subarray(0, blob.length - 16);
  const decipher = crypto.createDecipheriv('chacha20-poly1305', subkey, nonce12, { authTagLength: 16 });
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// Rust `CloudClient` note-update envelope: v6, AAD `{noteId}-{ts}`, meta carries
// the device/ts/sequence/noteId identity check.
function sealV6Envelope(sharedKeyHex, noteId, ts, device, sequence, updateBytes) {
  const aad = `${noteId}-${ts}`;
  const nonce = crypto.randomBytes(24);
  const enc = xchachaEncrypt(Buffer.from(sharedKeyHex, 'hex'), nonce, updateBytes, aad);
  return JSON.stringify({
    v: 6,
    meta: { device, ts, sequence, noteId },
    iv: nonce.toString('hex'),
    enc: enc.toString('base64'),
  });
}

function openV6Envelope(sharedKeyHex, noteId, ts, envelopeString) {
  const env = JSON.parse(envelopeString);
  assert.equal(env.v, 6, 'envelope must be v6');
  const aad = `${noteId}-${ts}`;
  return xchachaDecrypt(
    Buffer.from(sharedKeyHex, 'hex'),
    Buffer.from(env.iv, 'hex'),
    Buffer.from(env.enc, 'base64'),
    aad
  );
}

// Rust asset envelope: v6, AAD `asset:{flatKey}`, meta carries the asset key.
function sealAssetV6Envelope(sharedKeyHex, flatKey, bytes) {
  const aad = `asset:${flatKey}`;
  const nonce = crypto.randomBytes(24);
  const enc = xchachaEncrypt(Buffer.from(sharedKeyHex, 'hex'), nonce, bytes, aad);
  return Buffer.from(JSON.stringify({
    v: 6,
    meta: { asset: flatKey },
    iv: nonce.toString('hex'),
    enc: enc.toString('base64'),
  }), 'utf8');
}

async function makeKeypair() {
  const k = await createMlKem768();
  const [pk, sk] = k.generateKeyPair();
  return { pk: Buffer.from(pk).toString('hex'), sk: Buffer.from(sk).toString('hex') };
}

function json(app, headers, method, url, payload) {
  return app.inject({
    method,
    url,
    headers: { ...headers, 'content-type': 'application/json' },
    payload: payload === undefined ? undefined : JSON.stringify(payload),
  });
}

const NOTE_KEY_HEX = crypto.randomBytes(32).toString('hex');

// This suite uploads and reads real objects, so it needs live object storage.
// Otherwise it fails with a raw ECONNREFUSED (::1:9000) that reads like a
// regression. Probe once and skip cleanly with a clear reason, mirroring the
// client's cross-device-decrypt suite.
const NO_STORAGE_REASON = `skipping: object storage unreachable at ${process.env.STORAGE_ENDPOINT ?? 'localhost:9000'}`;

let storageReachable = null;
async function objectStorageReachable() {
  if (storageReachable !== null) return storageReachable;
  try {
    await require('../src/services/r2').listObjects('');
    storageReachable = true;
  } catch {
    storageReachable = false;
  }
  return storageReachable;
}

test.before(async () => {
  await setupTestDb();
  await cleanTestDb();
});

test.after(async () => {
  await cleanTestDb();
  await close();
});

test('two accounts share a note key: envelope fan-out, v6 pull, history, assets', async (t) => {
  if (!(await objectStorageReachable())) return t.skip(NO_STORAGE_REASON);
  // The replication is the real algorithm, not merely self-consistent.
  const hchachaKat = hchacha20(
    Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex'),
    Buffer.from('000000090000004a0000000031415927', 'hex')
  ).toString('hex');
  assert.equal(
    hchachaKat,
    '82413b4227b27bfed30e42508a877d73a0f9e4d58a74a853c12ec41326d3ecdc',
    'HChaCha20 known-answer vector'
  );

  const app = await buildApp();
  t.after(async () => { await app.close(); });

  // --- accounts (distinct accounts, each with its own ML-KEM-768 keypair) ----
  const aliceKp = await makeKeypair();
  const bobKp = await makeKeypair();
  const bobDevice2Kp = await makeKeypair();
  const outsiderKp = await makeKeypair();

  const aliceEmail = `e2e-alice-${crypto.randomBytes(4).toString('hex')}@test.example`;
  const bobEmail = `e2e-bob-${crypto.randomBytes(4).toString('hex')}@test.example`;
  const alice = await register('team', { email: aliceEmail });
  const bob = await register('team', { email: bobEmail });
  const outsider = await register('pro');

  await query(
    'UPDATE accounts SET username = $1, kem_public_key = $2, device_keys = $3 WHERE id = $4',
    ['e2e-alice', aliceKp.pk, JSON.stringify([{ deviceId: 'dev-a', publicKey: aliceKp.pk }]), alice.id]
  );
  await query(
    'UPDATE accounts SET username = $1, kem_public_key = $2, device_keys = $3 WHERE id = $4',
    ['e2e-bob', bobKp.pk, JSON.stringify([
      { deviceId: 'dev-b', publicKey: bobKp.pk },
      { deviceId: 'dev-b2', publicKey: bobDevice2Kp.pk },
    ]), bob.id]
  );
  await query(
    'UPDATE accounts SET username = $1, kem_public_key = $2 WHERE id = $3',
    ['e2e-outsider', outsiderKp.pk, outsider.id]
  );
  await query('UPDATE subscriptions SET storage_quota_bytes = 50000000000 WHERE account_id IN ($1, $2, $3)', [alice.id, bob.id, outsider.id]);

  const aliceHeaders = { ...(await authHeaders(alice.id)), 'x-device-id': 'dev-a' };
  const bobHeaders = { ...(await authHeaders(bob.id)), 'x-device-id': 'dev-b' };
  const bobDevice2Headers = { authorization: `Bearer ${await createSession(bob.id, { headers: { 'x-device-id': 'dev-b2' } })}`, 'x-device-id': 'dev-b2' };
  const outsiderHeaders = { ...(await authHeaders(outsider.id)), 'x-device-id': 'dev-out' };

  // --- 1. A creates a workspace; B joins it through the real invite API ------
  const wsId = `ws-${crypto.randomUUID()}`;
  await query(
    'INSERT INTO workspaces (id, name_encrypted, owner_id, created_at) VALUES ($1, $2, $3, $4)',
    [wsId, 'enc-name', alice.id, new Date().toISOString()]
  );
  await query(
    'INSERT INTO workspace_members (workspace_id, account_id, role, created_at) VALUES ($1, $2, $3, $4)',
    [wsId, alice.id, 'owner', new Date().toISOString()]
  );

  const invite = await json(app, aliceHeaders, 'POST', `/workspaces/${wsId}/members`, { email: bobEmail });
  assert.equal(invite.statusCode, 201, invite.body);
  const join = await json(app, bobHeaders, 'POST', `/workspaces/join/${invite.json().token}`);
  assert.equal(join.statusCode, 200, join.body);
  assert.equal(join.json().workspaceId, wsId);
  assert.equal(join.json().role, 'editor', 'B joins as an editor member');

  // --- 2. workspace key envelopes per device ---------------------------------
  const wsKeyHex = crypto.randomBytes(32).toString('hex');
  const aliceWsEnvelope = JSON.stringify(await wrapForRecipient(aliceKp.pk, wsKeyHex));
  const seedWs = await json(app, aliceHeaders, 'POST', `/workspaces/${wsId}/keys`, {
    recipients: [{ userId: alice.id, deviceId: 'dev-a', wrappedKey: aliceWsEnvelope }],
  });
  assert.equal(seedWs.statusCode, 201, seedWs.body);
  assert.equal(seedWs.json().stored, 1);

  const wsPubBefore = await app.inject({ method: 'GET', url: `/workspaces/${wsId}/public-keys`, headers: aliceHeaders });
  const bobWsBefore = wsPubBefore.json().collaborators.find((c) => c.userId === bob.id && c.deviceId === 'dev-b');
  assert.equal(bobWsBefore.hasEnvelope, false, 'B has no workspace envelope yet');

  const wrapWsForBob = await json(app, aliceHeaders, 'POST', `/workspaces/${wsId}/keys`, {
    recipients: [{ userId: bob.id, deviceId: 'dev-b', wrappedKey: JSON.stringify(await wrapForRecipient(bobKp.pk, wsKeyHex)) }],
  });
  assert.equal(wrapWsForBob.statusCode, 201, wrapWsForBob.body);
  assert.equal(wrapWsForBob.json().stored, 1);

  const bobWsList = await app.inject({ method: 'GET', url: '/workspaces', headers: bobHeaders });
  const bobWs = bobWsList.json().workspaces.find((w) => w.id === wsId);
  const bobWsEnvelope = bobWs.wrappedKeys.find((e) => e.deviceId === 'dev-b');
  assert.ok(bobWsEnvelope, 'B sees its per-device workspace envelope');
  assert.equal(await unwrapForRecipient(bobKp.sk, JSON.parse(bobWsEnvelope.wrappedKey)), wsKeyHex);

  // --- 3. A creates a note (journal row) and provisions the per-note key -----
  const noteId = `note-${crypto.randomUUID()}`;
  const aliceTs = Date.now();
  const aliceInitial = Buffer.from('alice-initial-yjs-state');
  const aliceEnvelope = sealV6Envelope(NOTE_KEY_HEX, noteId, aliceTs, 'dev-a', 1, aliceInitial);
  const alicePush = await json(app, aliceHeaders, 'POST', '/yjs/push-batch', {
    workspaceId: wsId,
    notes: [{
      noteId,
      updates: [{
        key: `${noteId}~~dev-a~~${aliceTs}~~1.yjs.json`,
        data: Buffer.from(aliceEnvelope, 'utf8').toString('base64'),
        deviceId: 'dev-a',
        sequence: 1,
        ts: aliceTs,
      }],
    }],
  });
  assert.equal(alicePush.statusCode, 201, alicePush.body);
  assert.equal(alicePush.json().accepted, 1);

  const bootstrap = await json(app, aliceHeaders, 'POST', `/collaboration/keys/${noteId}`);
  assert.equal(bootstrap.statusCode, 200, bootstrap.body);
  assert.equal(bootstrap.json().noteHasKey, false, 'fresh note has no key yet');

  const noteInvite = await json(app, aliceHeaders, 'POST', `/collaboration/invite/${noteId}`, { email: bobEmail });
  assert.equal(noteInvite.statusCode, 201, noteInvite.body);
  assert.equal(noteInvite.json().userId, bob.id);

  const seedNoteKey = await json(app, aliceHeaders, 'POST', `/collaboration/keys/${noteId}/recipients`, {
    recipients: [
      { userId: alice.id, deviceId: 'dev-a', wrappedKey: JSON.stringify(await wrapForRecipient(aliceKp.pk, NOTE_KEY_HEX)) },
    ],
  });
  assert.equal(seedNoteKey.statusCode, 200, seedNoteKey.body);
  assert.equal(seedNoteKey.json().stored, 1);
  assert.equal(seedNoteKey.json().existing, false);

  // B is a collaborator but holds no envelope: it must be visible as such.
  const pubKeys = await app.inject({ method: 'GET', url: `/collaboration/public-keys/${noteId}`, headers: aliceHeaders });
  assert.equal(pubKeys.statusCode, 200, pubKeys.body);
  const bobEntry = pubKeys.json().collaborators.find((c) => c.userId === bob.id && c.deviceId === 'dev-b');
  assert.ok(bobEntry, 'B is listed as a collaborator device');
  assert.equal(bobEntry.hasEnvelope, false, 'B has no note-key envelope yet');

  // --- 5. a caller WITHOUT an envelope cannot provision itself (no rotation) --
  const bobHoldingsBefore = (await query(
    'SELECT COUNT(*)::int AS c FROM note_keys WHERE note_id = $1 AND user_id = $2',
    [noteId, bob.id]
  )).rows[0].c;
  assert.equal(bobHoldingsBefore, 0);

  const selfProvision = await json(app, bobHeaders, 'POST', `/collaboration/keys/${noteId}/recipients`, {
    recipients: [
      { userId: bob.id, deviceId: 'dev-b', wrappedKey: JSON.stringify(await wrapForRecipient(bobKp.pk, crypto.randomBytes(32).toString('hex'))) },
    ],
  });
  assert.equal(selfProvision.statusCode, 200, selfProvision.body);
  assert.equal(selfProvision.json().stored, 0, 'self-provisioning must not store an envelope');
  assert.equal(selfProvision.json().existing, true);
  assert.equal(selfProvision.json().noteHasKey, true);

  const bobHoldingsAfter = (await query(
    'SELECT COUNT(*)::int AS c FROM note_keys WHERE note_id = $1 AND user_id = $2',
    [noteId, bob.id]
  )).rows[0].c;
  assert.equal(bobHoldingsAfter, 0, 'no envelope may be inserted for a keyless caller');

  // The keyed envelope must still unwrap to the ORIGINAL key (no rotation).
  const aliceEnvelopeRow = (await query(
    'SELECT wrapped_key FROM note_keys WHERE note_id = $1 AND user_id = $2 AND device_id = $3',
    [noteId, alice.id, 'dev-a']
  )).rows[0];
  assert.equal(await unwrapForRecipient(aliceKp.sk, JSON.parse(aliceEnvelopeRow.wrapped_key)), NOTE_KEY_HEX);

  // --- 3 (cont). A (key-holder) wraps B's late device; B unwraps its own ------
  const wrapNoteForBob = await json(app, aliceHeaders, 'POST', `/collaboration/keys/${noteId}/recipients`, {
    recipients: [
      { userId: bob.id, deviceId: 'dev-b', wrappedKey: JSON.stringify(await wrapForRecipient(bobKp.pk, NOTE_KEY_HEX)) },
      { userId: bob.id, deviceId: 'dev-b2', wrappedKey: JSON.stringify(await wrapForRecipient(bobDevice2Kp.pk, NOTE_KEY_HEX)) },
    ],
  });
  assert.equal(wrapNoteForBob.statusCode, 200, wrapNoteForBob.body);
  assert.equal(wrapNoteForBob.json().stored, 2);

  const pubKeysAfter = await app.inject({ method: 'GET', url: `/collaboration/public-keys/${noteId}`, headers: aliceHeaders });
  const bobEntryAfter = pubKeysAfter.json().collaborators.find((c) => c.userId === bob.id && c.deviceId === 'dev-b');
  assert.equal(bobEntryAfter.hasEnvelope, true, 'B now holds an envelope');

  const bobKeys = await app.inject({ method: 'GET', url: `/collaboration/keys/${noteId}`, headers: bobHeaders });
  assert.equal(bobKeys.statusCode, 200, bobKeys.body);
  const bobNoteEnvelope = bobKeys.json().wrappedKeys.find((k) => k.deviceId === 'dev-b');
  assert.ok(bobNoteEnvelope, 'B fetches only its own device envelope');
  assert.equal(
    await unwrapForRecipient(bobKp.sk, JSON.parse(bobNoteEnvelope.wrappedKey)),
    NOTE_KEY_HEX,
    'B unwraps the shared note key with its own ML-KEM secret'
  );

  // Late second device of the same account: add-only envelope, same key.
  const bobDevice2Keys = await app.inject({ method: 'GET', url: `/collaboration/keys/${noteId}`, headers: bobDevice2Headers });
  const bobDevice2Envelope = bobDevice2Keys.json().wrappedKeys.find((k) => k.deviceId === 'dev-b2');
  assert.ok(bobDevice2Envelope, 'the late device gets its own envelope');
  assert.equal(await unwrapForRecipient(bobDevice2Kp.sk, JSON.parse(bobDevice2Envelope.wrappedKey)), NOTE_KEY_HEX);

  // --- 4. B pushes a v6 update; A pulls and decrypts it with the shared key --
  const bobTs = Date.now() + 1000;
  const bobUpdate = Buffer.from('bob-collaborative-yjs-update');
  const bobEnvelope = sealV6Envelope(NOTE_KEY_HEX, noteId, bobTs, 'dev-b', 1, bobUpdate);
  const bobPush = await json(app, bobHeaders, 'POST', '/yjs/push-batch', {
    workspaceId: wsId,
    notes: [{
      noteId,
      updates: [{
        key: `${noteId}~~dev-b~~${bobTs}~~1.yjs.json`,
        data: Buffer.from(bobEnvelope, 'utf8').toString('base64'),
        deviceId: 'dev-b',
        sequence: 1,
        ts: bobTs,
      }],
    }],
  });
  assert.equal(bobPush.statusCode, 201, bobPush.body);
  assert.equal(bobPush.json().accepted, 1, 'B (workspace editor) pushes into the shared workspace');

  const alicePull = await json(app, aliceHeaders, 'POST', '/yjs/pull-batch', {
    workspaceId: wsId,
    notes: [{ noteId, checkpoint: {}, limit: 500 }],
  });
  assert.equal(alicePull.statusCode, 200, alicePull.body);
  const pulled = alicePull.json().notes[noteId].updates
    .filter((u) => u.key.includes('~~dev-b~~'));
  assert.equal(pulled.length, 1, 'A pulls B\'s update');
  const pulledPayload = Buffer.from(pulled[0].data, 'base64').toString('utf8');
  const pulledEnvelope = JSON.parse(pulledPayload);
  assert.equal(pulledEnvelope.v, 6, 'the pulled payload is the shared-key v6 form');
  assert.equal(pulledEnvelope.meta.device, 'dev-b');
  assert.equal(pulledEnvelope.meta.noteId, noteId);
  assert.equal(pulledEnvelope.meta.ts, bobTs);
  assert.deepEqual(
    openV6Envelope(NOTE_KEY_HEX, noteId, bobTs, pulledPayload),
    bobUpdate,
    'the shared key recovers B\'s plaintext'
  );
  assert.throws(
    () => openV6Envelope(crypto.randomBytes(32).toString('hex'), noteId, bobTs, pulledPayload),
    /Unsupported state|unable to authenticate|bad decrypt/i
  );

  // --- 6. history is shared between members; outsiders are denied -------------
  const commitTs = Date.now() + 2000;
  const commitId = `${commitTs}-dev-a-1`;
  const commitEnvelope = sealV6Envelope(NOTE_KEY_HEX, noteId, commitTs, 'dev-a', 1, Buffer.from('history-revision'));
  const commitPost = await json(app, { ...aliceHeaders, 'x-note-id': noteId }, 'POST', '/commits', {
    id: commitId,
    deviceId: 'dev-a',
    clock: 1,
    ts: commitTs,
    payload: commitEnvelope,
  });
  assert.equal(commitPost.statusCode, 201, commitPost.body);

  const aliceHistory = await app.inject({
    method: 'GET', url: `/commits/history?noteId=${encodeURIComponent(noteId)}`, headers: aliceHeaders,
  });
  const bobHistory = await app.inject({
    method: 'GET', url: `/commits/history?noteId=${encodeURIComponent(noteId)}`, headers: bobHeaders,
  });
  assert.equal(aliceHistory.json().commits.length, 1);
  assert.equal(bobHistory.json().commits.length, 1, 'B sees the same history as A');
  assert.equal(bobHistory.json().commits[0].commitid, commitId);

  const bobCommit = await app.inject({
    method: 'GET', url: `/commits/${commitId}`, headers: { ...bobHeaders, 'x-note-id': noteId },
  });
  assert.equal(bobCommit.statusCode, 200, bobCommit.body);
  assert.equal(bobCommit.json(), commitEnvelope, 'cross-account GET /commits/:id returns the stored v6 envelope');
  assert.deepEqual(openV6Envelope(NOTE_KEY_HEX, noteId, commitTs, bobCommit.json()), Buffer.from('history-revision'));

  const outsiderHistory = await app.inject({
    method: 'GET', url: `/commits/history?noteId=${encodeURIComponent(noteId)}`, headers: outsiderHeaders,
  });
  assert.equal(outsiderHistory.json().commits.length, 0, 'a non-member sees no history');
  const outsiderCommit = await app.inject({
    method: 'GET', url: `/commits/${commitId}`, headers: { ...outsiderHeaders, 'x-note-id': noteId },
  });
  assert.equal(outsiderCommit.statusCode, 404, 'a non-member cannot read the commit object');

  // --- 7. workspace-scoped asset, sealed v6, opaque to the server -------------
  // A short key first, then a path-length key (>100 chars) below to cover the
  // raised Fastify maxParamLength.
  const flatAssetKey = `assets--${wsId}--${noteId}--a.png`;
  assert.deepEqual(decodeAssetKey(flatAssetKey), {
    type: 'assets', workspaceId: wsId, noteId, filename: 'a.png',
  });

  const assetPlaintext = Buffer.from('PNG-PLAINTEXT-MARKER-not-for-server');
  const assetEnvelopeBytes = sealAssetV6Envelope(NOTE_KEY_HEX, flatAssetKey, assetPlaintext);
  const upload = await json(app, aliceHeaders, 'POST', '/assets/batch', {
    assets: [{ key: flatAssetKey, data: assetEnvelopeBytes.toString('base64') }],
  });
  assert.equal(upload.statusCode, 200, upload.body);
  assert.equal(upload.json().uploaded, 1);

  const fetched = await app.inject({
    method: 'GET', url: `/assets/${flatAssetKey}/content`, headers: aliceHeaders,
  });
  assert.equal(fetched.statusCode, 200, fetched.body);
  const storedBytes = Buffer.from(fetched.rawPayload);
  assert.ok(storedBytes.equals(assetEnvelopeBytes), 'server round-trips the exact v6 envelope bytes');
  assert.ok(!storedBytes.toString('utf8').includes('PNG-PLAINTEXT-MARKER'), 'server never holds asset plaintext');
  assert.equal(JSON.parse(storedBytes.toString('utf8')).v, 6);
  const assetEnv = JSON.parse(storedBytes.toString('utf8'));
  assert.deepEqual(
    xchachaDecrypt(
      Buffer.from(NOTE_KEY_HEX, 'hex'),
      Buffer.from(assetEnv.iv, 'hex'),
      Buffer.from(assetEnv.enc, 'base64'),
      `asset:${flatAssetKey}`
    ),
    assetPlaintext,
    'the shared key recovers the asset plaintext'
  );

  // Assets are account-prefixed on the server: the collaborator's key schedule
  // is shared, but the blob itself is not addressable cross-account.
  // A filename-carrying key is account-scoped: the shared prefix is reserved for
  // hashed keys whose workspace the upload path can derive. The owner's copy is
  // still readable by a workspace member, or a seeded attachment reads as
  // "File not found" on every peer.
  const bobAsset = await app.inject({
    method: 'GET', url: `/assets/${flatAssetKey}/content`, headers: bobHeaders,
  });
  assert.equal(bobAsset.statusCode, 200, bobAsset.body);
  assert.ok(
    Buffer.from(bobAsset.rawPayload).equals(assetEnvelopeBytes),
    'a workspace member fetches the same envelope the uploader stored'
  );
  const outsiderAsset = await app.inject({
    method: 'GET', url: `/assets/${flatAssetKey}/content`, headers: outsiderHeaders,
  });
  assert.equal(outsiderAsset.statusCode, 404, 'a non-member cannot fetch a workspace asset');

  const aliceListing = await app.inject({
    method: 'GET', url: `/assets?workspaceId=${encodeURIComponent(wsId)}`, headers: aliceHeaders,
  });
  assert.ok(aliceListing.json().keys.includes(flatAssetKey), 'A lists the workspace-scoped asset');
  const bobListing = await app.inject({
    method: 'GET', url: `/assets?workspaceId=${encodeURIComponent(wsId)}`, headers: bobHeaders,
  });
  assert.deepEqual(bobListing.json().keys, [], 'an account-scoped copy stays out of B\'s listing');

  // A hashed key names its workspace, so an upload with no workspace context
  // still lands in the shared prefix: one object, visible and readable for
  // every member (the seeding path used to strand it in the uploader's prefix).
  const hashedAssetKey = `assets--${wsId}--${noteId}--${crypto.randomBytes(32).toString('base64url')}`;
  const hashedUpload = await json(app, aliceHeaders, 'POST', '/assets/batch', {
    assets: [{ key: hashedAssetKey, data: assetEnvelopeBytes.toString('base64') }],
  });
  assert.equal(hashedUpload.statusCode, 200, hashedUpload.body);
  const bobHashedListing = await app.inject({
    method: 'GET', url: `/assets?workspaceId=${encodeURIComponent(wsId)}`, headers: bobHeaders,
  });
  assert.ok(
    bobHashedListing.json().keys.includes(hashedAssetKey),
    'a hashed workspace key is listed for every member'
  );
  const bobHashedFetch = await app.inject({
    method: 'GET', url: `/assets/${hashedAssetKey}/content`, headers: bobHeaders,
  });
  assert.equal(bobHashedFetch.statusCode, 200, bobHashedFetch.body);

  // A realistic filename exceeds Fastify's old 100-char maxParamLength once the
  // workspace segment is present. Opaque keys are longer still, so the server
  // now raises maxParamLength (see src/server.js); a long key must round-trip
  // through the path-param routes instead of 414ing.
  const longAssetKey = `assets--${wsId}--${noteId}--screenshot-revision-2026.png`;
  assert.ok(longAssetKey.length > 100);
  const longUpload = await json(app, aliceHeaders, 'POST', '/assets/batch', {
    assets: [{ key: longAssetKey, data: assetEnvelopeBytes.toString('base64') }],
  });
  assert.equal(longUpload.statusCode, 200, longUpload.body);
  assert.equal(longUpload.json().uploaded, 1, 'storage accepts the long key via the batch body');
  const longFetch = await app.inject({
    method: 'GET', url: `/assets/${longAssetKey}/content`, headers: aliceHeaders,
  });
  assert.equal(longFetch.statusCode, 200, longFetch.body);
  assert.ok(
    Buffer.from(longFetch.rawPayload).equals(assetEnvelopeBytes),
    'the long key path-param route round-trips the envelope'
  );
});
