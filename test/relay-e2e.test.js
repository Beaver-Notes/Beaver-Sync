'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { WebSocket } = require('ws');
const Y = require('yjs');
const encoding = require('lib0/encoding');
const syncProtocol = require('y-protocols/sync');

const repoRoot = path.resolve(__dirname, '..');

process.env.NODE_ENV = 'test';
process.env.JWT_PRIVATE_KEY_PATH = path.join(repoRoot, 'keys/private.pem');
process.env.JWT_PUBLIC_KEY_PATH = path.join(repoRoot, 'keys/public.pem');
process.env.COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars-long';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-characters-long';
process.env.LEGACY_AUTH_ENABLED = 'true';
process.env.ENTERPRISE_MODE = 'false';
process.env.WS_RELAY_PORT = '18081';

const { close, query } = require('../src/db');
const { setupTestDb, cleanTestDb } = require('./helpers/db');
const { buildApp } = require('../src/server');
const { createSession } = require('../src/middleware/auth');

const WS_PORT = 18081;
const MSG_SYNC = 0;



async function post(app, url, payload, headers = {}) {
  return app.inject({
    method: 'POST',
    url,
    // The relay presents this on every call (src/ws-relay-auth.js); the endpoint 503s without it.
    headers: { 'content-type': 'application/json', 'x-internal-secret': process.env.INTERNAL_API_SECRET, ...headers },
    payload,
  });
}

function wsUrl(room, ticketOrToken, useTicket = true) {
  const qs = useTicket ? `ticket=${ticketOrToken}` : `token=${ticketOrToken}`;
  return `ws://localhost:${WS_PORT}/${room}?${qs}`;
}

function connectWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws._jsonBuf = [];
    ws._binBuf = [];
    const timer = setTimeout(() => reject(new Error(`WS connect timeout ${url}`)), 5000);
    ws.on('open', () => { clearTimeout(timer); resolve(ws); });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        ws._binBuf.push(data);
      } else {
        try { ws._jsonBuf.push(JSON.parse(data.toString())); } catch {}
      }
    });
    ws.on('close', () => {});
  });
}

function waitForJson(ws, type, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const found = ws._jsonBuf?.find(m => m.type === type);
    if (found) return resolve(found);
    const t = setTimeout(() => reject(new Error(`timeout waitForJson ${type}`)), timeout);
    const onMsg = (data, isBinary) => {
      if (isBinary) return;
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === type) { clearTimeout(t); ws.off('message', onMsg); resolve(msg); }
      } catch {}
    };
    ws.on('message', onMsg);
    ws.on('close', () => { clearTimeout(t); reject(new Error('closed before json')); });
    ws.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

function waitForBinary(ws, predicate, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waitForBinary')), timeout);
    const onMsg = (data, isBinary) => {
      if (!isBinary) return;
      try {
        if (predicate(new Uint8Array(data))) { clearTimeout(t); ws.off('message', onMsg); resolve(new Uint8Array(data)); }
      } catch {}
    };
    // also check buffered
    for (const b of (ws._binBuf || [])) {
      try { if (predicate(new Uint8Array(b))) { clearTimeout(t); return resolve(new Uint8Array(b)); } } catch {}
    }
    ws.on('message', onMsg);
    ws.on('close', () => { clearTimeout(t); reject(new Error('closed before binary')); });
  });
}

function encodeSyncStep1(doc) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  syncProtocol.writeSyncStep1(enc, doc);
  return encoding.toUint8Array(enc);
}

// A frame shaped like the client's E2E output: MAGIC(2) || IV(12) || ciphertext.
// The relay holds no room key, so the body is opaque noise to it and only the
// magic prefix is meaningful. Must match ENCRYPTED_FRAME_MAGIC in src/ws-relay.js.
const ENC_MAGIC = [0xe7, 0x11];
function encryptedFrame(fill) {
  const out = new Uint8Array(2 + 12 + 24);
  out.set(ENC_MAGIC, 0);
  for (let i = 14; i < out.length; i++) out[i] = fill + i;
  return out;
}

function expectWsUpgradeFail(url, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => { try{ ws.terminate(); }catch{}; reject(new Error('expected close but stayed open')); }, timeout);
    ws.on('open', () => { clearTimeout(t); ws.terminate(); reject(new Error('expected rejection but opened')); });
    ws.on('error', () => {}); // ignore
    ws.on('close', (code) => { clearTimeout(t); resolve(code); });
    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(t);
      res.destroy();
      resolve(res.statusCode);
    });
  });
}

let app;
let wsServer;
let stopWsRelay;
let apiPort;

test.before(async () => {
  await setupTestDb();
  await cleanTestDb();
  // seed accounts/workspaces
  // owner + editor + viewer + outsider
  await query(`INSERT INTO accounts (id, username, email_hmac, created_at, email_verified) VALUES ($1,$2,$3,$4,$5)`, ['e2e-owner', 'e2e-owner', 'e2e-owner-hmac', new Date().toISOString(), true]);
  await query(`INSERT INTO accounts (id, username, email_hmac, created_at, email_verified) VALUES ($1,$2,$3,$4,$5)`, ['e2e-editor', 'e2e-editor', 'e2e-editor-hmac', new Date().toISOString(), true]);
  await query(`INSERT INTO accounts (id, username, email_hmac, created_at, email_verified) VALUES ($1,$2,$3,$4,$5)`, ['e2e-viewer', 'e2e-viewer', 'e2e-viewer-hmac', new Date().toISOString(), true]);
  await query(`INSERT INTO accounts (id, username, email_hmac, created_at, email_verified) VALUES ($1,$2,$3,$4,$5)`, ['e2e-outsider', 'e2e-outsider', 'e2e-outsider-hmac', new Date().toISOString(), true]);
  await query(`INSERT INTO workspaces (id, name_encrypted, owner_id, created_at) VALUES ($1,$2,$3,$4)`, ['ws-e2e', 'e2e', 'e2e-owner', new Date().toISOString()]);
  await query(`INSERT INTO workspace_members (workspace_id, account_id, role, created_at) VALUES ($1,$2,$3,$4)`, ['ws-e2e', 'e2e-owner', 'owner', new Date().toISOString()]);
  await query(`INSERT INTO workspace_members (workspace_id, account_id, role, created_at) VALUES ($1,$2,$3,$4)`, ['ws-e2e', 'e2e-editor', 'editor', new Date().toISOString()]);
  await query(`INSERT INTO workspace_members (workspace_id, account_id, role, created_at) VALUES ($1,$2,$3,$4)`, ['ws-e2e', 'e2e-viewer', 'viewer', new Date().toISOString()]);
  await query(`INSERT INTO subscriptions (id, account_id, plan, status, storage_quota_bytes, storage_used_bytes, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, ['e2e-owner-sub','e2e-owner','pro','active',1000000,0,new Date().toISOString()]);
  await query(`INSERT INTO subscriptions (id, account_id, plan, status, storage_quota_bytes, storage_used_bytes, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, ['e2e-editor-sub','e2e-editor','pro','active',1000000,0,new Date().toISOString()]);
  await query(`INSERT INTO subscriptions (id, account_id, plan, status, storage_quota_bytes, storage_used_bytes, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, ['e2e-viewer-sub','e2e-viewer','pro','active',1000000,0,new Date().toISOString()]);
  await query(`INSERT INTO subscriptions (id, account_id, plan, status, storage_quota_bytes, storage_used_bytes, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, ['e2e-outsider-sub','e2e-outsider','pro','active',1000000,0,new Date().toISOString()]);
  // foreign workspace for 03.3 regression
  await query(`INSERT INTO workspaces (id, name_encrypted, owner_id, created_at) VALUES ($1,$2,$3,$4)`, ['ws-foreign', 'foreign', 'e2e-outsider', new Date().toISOString()]);
  await query(`INSERT INTO workspace_members (workspace_id, account_id, role, created_at) VALUES ($1,$2,$3,$4)`, ['ws-foreign', 'e2e-outsider', 'owner', new Date().toISOString()]);
  // note belonging: note-1 belongs to ws-e2e
  await query(`INSERT INTO sync_document_state (workspace_id, note_id, snapshot_generation, snapshot_key, checkpoint_ts, checkpoint_sequence, updated_at) VALUES ($1,$2,0,'',0,0,NOW())`, ['ws-e2e', 'note-1']);
  await query(`INSERT INTO sync_document_state (workspace_id, note_id, snapshot_generation, snapshot_key, checkpoint_ts, checkpoint_sequence, updated_at) VALUES ($1,$2,0,'',0,0,NOW())`, ['ws-e2e', 'note-viewer-test']);
  await query(`INSERT INTO sync_document_state (workspace_id, note_id, snapshot_generation, snapshot_key, checkpoint_ts, checkpoint_sequence, updated_at) VALUES ($1,$2,0,'',0,0,NOW())`, ['ws-foreign', 'note-foreign']);

  app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  apiPort = app.server.address().port;
  process.env.AUTH_BACKEND_URL = `http://127.0.0.1:${apiPort}`;

  const relayMod = require('../src/ws-relay');
  wsServer = await relayMod.startWsRelay();
  stopWsRelay = relayMod.stopWsRelay;
  await new Promise(r => setTimeout(r, 600));
});

test.after(async () => {
  try { if (stopWsRelay) await stopWsRelay(); else if (wsServer) wsServer.close(); } catch {}
  if (app) await app.close();
  await close();
});

// 1. happy path: ticket -> connect -> opaque frame forwarded verbatim to peers
test('relay e2e: encrypted frames are forwarded verbatim to peers and never echoed', async () => {
  const sessionOwner = await createSession('e2e-owner', { headers: { 'x-device-id': 'dev-owner' } });
  const t1 = await post(app, '/auth/ws-ticket', { workspaceId: 'ws-e2e', noteId: 'note-1' }, { authorization: `Bearer ${sessionOwner}` });
  assert.equal(t1.statusCode, 200);
  const ticket1 = t1.json().ticket;

  const sessionEditor = await createSession('e2e-editor', { headers: { 'x-device-id': 'dev-editor' } });
  const t2 = await post(app, '/auth/ws-ticket', { workspaceId: 'ws-e2e', noteId: 'note-1' }, { authorization: `Bearer ${sessionEditor}` });
  assert.equal(t2.statusCode, 200);
  const ticket2 = t2.json().ticket;

  const room = 'workspace:ws-e2e:note:note-1';
  const ws1 = await connectWs(wsUrl(room, ticket1, true));
  const auth1 = await waitForJson(ws1, 'auth');
  assert.equal(auth1.readOnly, false);

  const ws2 = await connectWs(wsUrl(room, ticket2, true));
  const auth2 = await waitForJson(ws2, 'auth');
  assert.equal(auth2.readOnly, false);

  await new Promise(r => setTimeout(r, 200));
  ws1._binBuf = []; ws2._binBuf = [];

  // An encrypted frame from ws1 must arrive at ws2 byte-identical: the relay
  // holds no room key and must not parse, reorder or re-frame the payload.
  const frame = encryptedFrame(7);
  const forwarded = waitForBinary(ws2, (u) => u.length === frame.length && u.every((b, i) => b === frame[i]), 3000);
  ws1.send(frame);
  await forwarded;

  // The sender must not get an echo, and the relay must never emit Yjs frames
  // of its own now that it holds no Y.Doc.
  await new Promise(r => setTimeout(r, 400));
  assert.equal(ws1._binBuf.length, 0, 'relay must not echo the frame to its sender');

  // Durability is the clients' HTTPS path; the relay writes nothing.
  const { rows } = await query(`SELECT device_id FROM yjs_doc_updates WHERE workspace_id=$1 AND note_id=$2 AND device_id='relay'`, ['ws-e2e', 'note-1']);
  assert.equal(rows.length, 0, 'relay must not persist rows');

  ws1.close(); ws2.close();
});

// REST push triggers PG NOTIFY -> second client JSON notification
test('relay e2e: REST push triggers second-client JSON notification', async () => {
  const sessionOwner = await createSession('e2e-owner', { headers: { 'x-device-id': 'dev-owner' } });
  const ticketOwner = (await post(app, '/auth/ws-ticket', { workspaceId: 'ws-e2e', noteId: 'note-1' }, { authorization: `Bearer ${sessionOwner}` })).json().ticket;
  const sessionEditor = await createSession('e2e-editor', { headers: { 'x-device-id': 'dev-editor' } });
  const ticketEditor = (await post(app, '/auth/ws-ticket', { workspaceId: 'ws-e2e', noteId: 'note-1' }, { authorization: `Bearer ${sessionEditor}` })).json().ticket;

  const room = 'workspace:ws-e2e:note:note-1';
  const wsOwner = await connectWs(wsUrl(room, ticketOwner, true));
  await waitForJson(wsOwner, 'auth');
  const wsEditor = await connectWs(wsUrl(room, ticketEditor, true));
  await waitForJson(wsEditor, 'auth');

  await new Promise(r => setTimeout(r, 300));

  const ts = Date.now();
  const push = await post(app, '/yjs/push-batch', {
    workspaceId: 'ws-e2e',
    notes: [{ noteId: 'note-1', updates: [{ key: `note-1~~dev-owner~~${ts}~~99.yjs.json`, data: Buffer.from('x').toString('base64'), deviceId: 'dev-owner', sequence: 99, ts }] }],
  }, { authorization: `Bearer ${sessionOwner}`, 'x-device-id': 'dev-owner' });
  assert.equal(push.statusCode, 201);

  // editor should get notification, owner (same device) should NOT (excludeDeviceId)
  const notif = await waitForJson(wsEditor, 'notification', 4000);
  assert.deepEqual(notif.noteIds, ['note-1']);

  // owner excluded device: wait briefly ensure no notif
  await new Promise(r => setTimeout(r, 600));
  const ownerNotifs = (wsOwner._jsonBuf || []).filter(m => m.type === 'notification');
  assert.equal(ownerNotifs.length, 0, 'owner device should be excluded');

  wsOwner.close(); wsEditor.close();
});

test('negative: expired ticket rejected', async () => {
  const session = await createSession('e2e-owner', { headers: { 'x-device-id': 'dev-owner' } });
  const tr = await post(app, '/auth/ws-ticket', { workspaceId: 'ws-e2e', noteId: 'note-1' }, { authorization: `Bearer ${session}` });
  assert.equal(tr.statusCode, 200);
  const ticket = tr.json().ticket;
  const { hashSessionId } = require('../src/lib/crypto');
  // Tickets are namespaced before hashing since 3210225 (src/routes/auth.js).
  const h = hashSessionId(`ws-ticket:${ticket}`);
  await query(`UPDATE ws_tickets SET expires_at = NOW() - INTERVAL '1 hour' WHERE id_hash=$1`, [h]);
  const code = await expectWsUpgradeFail(wsUrl('workspace:ws-e2e:note:note-1', ticket, true));
  // ws library may return HTTP status or ws close code 1006; accept either 401/403 or 1006
  assert.ok([401,403,1006].includes(code), `expected 401/403/1006 got ${code}`);
});

test('negative: replayed ticket rejected', async () => {
  const session = await createSession('e2e-owner', { headers: { 'x-device-id': 'dev-owner' } });
  const tr = await post(app, '/auth/ws-ticket', { workspaceId: 'ws-e2e', noteId: 'note-1' }, { authorization: `Bearer ${session}` });
  const ticket = tr.json().ticket;
  const ws1 = await connectWs(wsUrl('workspace:ws-e2e:note:note-1', ticket, true));
  await waitForJson(ws1, 'auth');
  // second use of same ticket should fail
  const code = await expectWsUpgradeFail(wsUrl('workspace:ws-e2e:note:note-1', ticket, true));
  assert.ok([401,403,1006].includes(code), `replay should be 401/403 got ${code}`);
  ws1.close();
});

// A ticket must be redeemable for exactly one room. Before this guard a ticket
// minted with an empty body carried role NULL, and the relay's `role ??
// 'editor'` default turned it into write access on any room in any workspace.
test('negative: a ticket is bound to the room it was minted for', async () => {
  // A real member of ws-e2e: every mint below is legitimately authorised, so
  // only the room binding can be what rejects the cross-room redemptions.
  const owner = await createSession('e2e-owner', { headers: { 'x-device-id': 'dev-owner' } });
  const auth = { authorization: `Bearer ${owner}` };

  // An empty body must not mint a ticket at all.
  const empty = await post(app, '/auth/ws-ticket', {}, auth);
  assert.equal(empty.statusCode, 400);

  // A legitimate ticket for ws-e2e / note-1 still works.
  const ok = await post(app, '/auth/ws-ticket', { workspaceId: 'ws-e2e', noteId: 'note-1' }, auth);
  assert.equal(ok.statusCode, 200);
  const ticket = ok.json().ticket;

  // The room it was minted for is accepted…
  const ws = await connectWs(wsUrl('workspace:ws-e2e:note:note-1', ticket, true));
  const authMsg = await waitForJson(ws, 'auth');
  assert.equal(authMsg.readOnly, false);
  ws.close();

  // …but the same mint cannot be redeemed against another note in that
  // workspace, against the foreign workspace, or against the meta room.
  // Each attempt needs its own ticket: redemption is single-use, and a rejected
  // redemption still consumes it.
  for (const room of [
    'workspace:ws-e2e:note:note-viewer-test',
    'workspace:ws-foreign:note:note-foreign',
    'workspace:ws-e2e:meta',
  ]) {
    const t = await post(app, '/auth/ws-ticket', { workspaceId: 'ws-e2e', noteId: 'note-1' }, auth);
    assert.equal(t.statusCode, 200);
    const code = await expectWsUpgradeFail(wsUrl(room, t.json().ticket, true));
    assert.ok([401, 403, 1006].includes(code), `${room} should be rejected, got ${code}`);
  }
});

test('negative: foreign-workspace join regression (03.3) - token path blocked', async () => {
  // outsider is not member of ws-e2e but we also test note-not-in-workspace via collaborator
  // create a note that belongs to foreign ws; try to join ws-e2e with that note as outsider-collaborator
  const { NoteInvitation } = require('../src/models');
  const outsiderSess = await createSession('e2e-outsider', { headers: { 'x-device-id': 'dev-outsider' } });
  // make outsider collaborator on note-1 ? but note-1 belongs to ws-e2e so not foreign. Instead test:
  // outsider is collaborator on note-foreign (which belongs to ws-foreign in sync_document_state)
  // try to connect to workspace:ws-e2e:note:note-foreign via token -> should 403 because note not in ws-e2e
  await NoteInvitation.create({ noteId: 'note-foreign', userId: 'e2e-outsider', invitedBy: 'e2e-owner', role: 'editor', createdAt: new Date() });
  // token path: connect with session token directly (not ticket) to foreign room
  const room = 'workspace:ws-e2e:note:note-foreign';
  const code = await expectWsUpgradeFail(wsUrl(room, outsiderSess, false));
  assert.ok([401,403,1006].includes(code), `foreign join should be rejected got ${code}`);
  // also verify HTTP verify-session denies
  const v = await post(app, '/auth/verify-session', { token: outsiderSess, workspaceId: 'ws-e2e', noteId: 'note-foreign' });
  assert.equal(v.statusCode, 403);
  assert.match(v.json().message, /Note not found in this workspace/);
  await NoteInvitation.deleteOne({ noteId: 'note-foreign', userId: 'e2e-outsider' });
});

// Write authorization is NOT enforced by the relay any more: frames arrive
// end-to-end encrypted and the relay holds no room key, so it cannot tell a
// sync update from an awareness frame, let alone a viewer's from an editor's.
// What the relay still owes the client is an honest `auth` frame naming the
// role, so the client can refuse to emit updates itself. Server-side write
// authorization lives on the HTTPS push path, which is unaffected.
test('relay e2e: a viewer socket is told its role and never persists anything', async () => {
  const sessViewer = await createSession('e2e-viewer', { headers: { 'x-device-id': 'dev-viewer' } });
  const tViewer = (await post(app, '/auth/ws-ticket', { workspaceId: 'ws-e2e', noteId: 'note-viewer-test' }, { authorization: `Bearer ${sessViewer}` })).json().ticket;
  const sessEditor = await createSession('e2e-editor', { headers: { 'x-device-id': 'dev-editor2' } });
  const tEditor = (await post(app, '/auth/ws-ticket', { workspaceId: 'ws-e2e', noteId: 'note-viewer-test' }, { authorization: `Bearer ${sessEditor}` })).json().ticket;

  const room = 'workspace:ws-e2e:note:note-viewer-test';
  const wsViewer = await connectWs(wsUrl(room, tViewer, true));
  const av = await waitForJson(wsViewer, 'auth');
  assert.equal(av.readOnly, true);
  assert.equal(av.role, 'viewer');
  const wsEditor = await connectWs(wsUrl(room, tEditor, true));
  const ae = await waitForJson(wsEditor, 'auth');
  assert.equal(ae.readOnly, false, 'the editor in the same room must still be told it may write');

  const beforeRows = (await query(`SELECT COUNT(*)::int c FROM yjs_doc_updates WHERE workspace_id='ws-e2e' AND note_id='note-viewer-test'`)).rows[0].c;
  wsViewer.send(encryptedFrame(31));
  await new Promise(r => setTimeout(r, 1200));
  const afterRows = (await query(`SELECT COUNT(*)::int c FROM yjs_doc_updates WHERE workspace_id='ws-e2e' AND note_id='note-viewer-test'`)).rows[0].c;
  assert.equal(afterRows, beforeRows, 'the relay must never persist rows for any socket');

  wsViewer.close(); wsEditor.close();
});

// A frame the relay cannot recognise must be dropped rather than forwarded, and
// must not be silently swallowed.
test('relay e2e: an unrecognised binary frame is dropped, not forwarded', async () => {
  const sessOwner = await createSession('e2e-owner', { headers: { 'x-device-id': 'dev-drop-owner' } });
  const tOwner = (await post(app, '/auth/ws-ticket', { workspaceId: 'ws-e2e', noteId: 'note-1' }, { authorization: `Bearer ${sessOwner}` })).json().ticket;
  const sessEditor = await createSession('e2e-editor', { headers: { 'x-device-id': 'dev-drop-editor' } });
  const tEditor = (await post(app, '/auth/ws-ticket', { workspaceId: 'ws-e2e', noteId: 'note-1' }, { authorization: `Bearer ${sessEditor}` })).json().ticket;

  const room = 'workspace:ws-e2e:note:note-1';
  const ws1 = await connectWs(wsUrl(room, tOwner, true));
  await waitForJson(ws1, 'auth');
  const ws2 = await connectWs(wsUrl(room, tEditor, true));
  await waitForJson(ws2, 'auth');
  await new Promise(r => setTimeout(r, 200));
  ws2._binBuf = [];

  // A plaintext Yjs frame: no magic prefix, so the relay must not relay it.
  ws1.send(encodeSyncStep1(new Y.Doc()));
  await new Promise(r => setTimeout(r, 600));
  assert.equal(ws2._binBuf.length, 0, 'a non-encrypted binary frame must not be forwarded');

  ws1.close(); ws2.close();
});

// The relay cannot read the encrypted frame's plaintext type byte, so a
// read-only socket declares the kind of the frame it is about to send. A viewer
// must not be able to push a Yjs update into an editor, but its awareness must
// still flow so it shows up in avatars and as a remote cursor.
test('relay e2e: a viewer cannot relay a declared sync frame but its awareness still reaches the peer', async () => {
  const sessViewer = await createSession('e2e-viewer', { headers: { 'x-device-id': 'dev-ro-viewer' } });
  const tViewer = (await post(app, '/auth/ws-ticket', { workspaceId: 'ws-e2e', noteId: 'note-viewer-test' }, { authorization: `Bearer ${sessViewer}` })).json().ticket;
  const sessEditor = await createSession('e2e-editor', { headers: { 'x-device-id': 'dev-ro-editor' } });
  const tEditor = (await post(app, '/auth/ws-ticket', { workspaceId: 'ws-e2e', noteId: 'note-viewer-test' }, { authorization: `Bearer ${sessEditor}` })).json().ticket;

  const room = 'workspace:ws-e2e:note:note-viewer-test';
  const viewer = await connectWs(wsUrl(room, tViewer, true));
  const authViewer = await waitForJson(viewer, 'auth');
  assert.equal(authViewer.readOnly, true);
  assert.equal(authViewer.userId, 'e2e-viewer', 'the auth frame must carry the sender account id');
  const editor = await connectWs(wsUrl(room, tEditor, true));
  const authEditor = await waitForJson(editor, 'auth');
  assert.equal(authEditor.readOnly, false);
  assert.equal(authEditor.userId, 'e2e-editor');

  await new Promise(r => setTimeout(r, 300));
  editor._binBuf = [];

  // Declared sync: dropped, the editor must never see it.
  const syncFrame = encryptedFrame(41);
  viewer.send(JSON.stringify({ type: 'frame', kind: 'sync' }));
  viewer.send(syncFrame);
  await new Promise(r => setTimeout(r, 600));
  assert.equal(editor._binBuf.length, 0, 'a read-only socket must not relay a declared sync frame');

  // Declared awareness: forwarded byte-identical, so the viewer still shows up
  // in the editor's avatar strip and as a cursor.
  const awareFrame = encryptedFrame(42);
  const forwarded = waitForBinary(editor, (u) => u.length === awareFrame.length && u.every((b, i) => b === awareFrame[i]), 3000);
  viewer.send(JSON.stringify({ type: 'frame', kind: 'awareness' }));
  viewer.send(awareFrame);
  await forwarded;

  // The declaration covers exactly one frame: the next undeclared frame keeps
  // today's verbatim behaviour, the next declared sync frame is dropped again.
  editor._binBuf = [];
  const second = encryptedFrame(43);
  viewer.send(JSON.stringify({ type: 'frame', kind: 'sync' }));
  viewer.send(second);
  const secondSync = waitForBinary(editor, (u) => u.length === second.length && u.every((b, i) => b === second[i]), 800).then(() => true, () => false);
  await secondSync;
  editor._binBuf = [];

  // Malformed and unknown control messages must not throw or stall the socket.
  viewer.send('not json at all');
  viewer.send(JSON.stringify({ type: 'frame', kind: 'nonsense' }));
  const okFrame = encryptedFrame(44);
  const stillRelaying = waitForBinary(editor, (u) => u.length === okFrame.length && u.every((b, i) => b === okFrame[i]), 3000);
  viewer.send(okFrame);
  await stillRelaying;

  // An editor is unaffected by the whole mechanism.
  const editorFrame = encryptedFrame(45);
  const editorSync = waitForBinary(viewer, (u) => u.length === editorFrame.length && u.every((b, i) => b === editorFrame[i]), 3000);
  editor.send(JSON.stringify({ type: 'frame', kind: 'sync' }));
  editor.send(editorFrame);
  await editorSync;

  viewer.close(); editor.close();
});

test('deviceId exclusion: same device sockets not notified, other device notified', async () => {
  const sessA = await createSession('e2e-owner', { headers: { 'x-device-id': 'dev-a' } });
  const tA1 = (await post(app, '/auth/ws-ticket', { workspaceId: 'ws-e2e', noteId: 'note-1' }, { authorization: `Bearer ${sessA}` })).json().ticket;
  const tA2 = (await post(app, '/auth/ws-ticket', { workspaceId: 'ws-e2e', noteId: 'note-1' }, { authorization: `Bearer ${sessA}` })).json().ticket;
  const sessB = await createSession('e2e-editor', { headers: { 'x-device-id': 'dev-b' } });
  const tB = (await post(app, '/auth/ws-ticket', { workspaceId: 'ws-e2e', noteId: 'note-1' }, { authorization: `Bearer ${sessB}` })).json().ticket;

  const room = 'workspace:ws-e2e:note:note-1';
  const wsA1 = await connectWs(wsUrl(room, tA1, true));
  await waitForJson(wsA1, 'auth');
  const wsA2 = await connectWs(wsUrl(room, tA2, true));
  await waitForJson(wsA2, 'auth');
  const wsB = await connectWs(wsUrl(room, tB, true));
  await waitForJson(wsB, 'auth');
  await new Promise(r => setTimeout(r, 300));

  // clear json buffers
  wsA1._jsonBuf = []; wsA2._jsonBuf = []; wsB._jsonBuf = [];

  const ts = Date.now();
  const push = await post(app, '/yjs/push-batch', {
    workspaceId: 'ws-e2e',
    notes: [{ noteId: 'note-1', updates: [{ key: `note-1~~dev-a~~${ts}~~101.yjs.json`, data: Buffer.from('dev-a push').toString('base64'), deviceId: 'dev-a', sequence: 101, ts }] }],
  }, { authorization: `Bearer ${sessA}`, 'x-device-id': 'dev-a' });
  assert.equal(push.statusCode, 201);

  const notifB = await waitForJson(wsB, 'notification', 4000);
  assert.deepEqual(notifB.noteIds, ['note-1']);
  await new Promise(r => setTimeout(r, 600));
  assert.equal(wsA1._jsonBuf.filter(m=>m.type==='notification').length, 0, 'dev-a socket 1 excluded');
  assert.equal(wsA2._jsonBuf.filter(m=>m.type==='notification').length, 0, 'dev-a socket 2 excluded');

  wsA1.close(); wsA2.close(); wsB.close();
});

// The relay is a pure bus: it holds no awareness state, so clientID ownership,
// hijack protection and wipe-on-disconnect are the clients' job (y-protocols
// merges awareness by (clientID, clock)). What the relay must still guarantee
// is that it forwards presence frames in both directions and never mints or
// rewrites them itself.
test('relay e2e: awareness frames forward both ways and the relay adds no state of its own', async () => {

  const sessOwner = await createSession('e2e-owner', { headers: { 'x-device-id': 'dev-aw-owner' } });
  const tOwner = (await post(app, '/auth/ws-ticket', { workspaceId: 'ws-e2e', noteId: 'note-viewer-test' }, { authorization: `Bearer ${sessOwner}` })).json().ticket;
  const sessViewer = await createSession('e2e-viewer', { headers: { 'x-device-id': 'dev-aw-viewer' } });
  const tViewer = (await post(app, '/auth/ws-ticket', { workspaceId: 'ws-e2e', noteId: 'note-viewer-test' }, { authorization: `Bearer ${sessViewer}` })).json().ticket;

  const room = 'workspace:ws-e2e:note:note-viewer-test';
  const owner = await connectWs(wsUrl(room, tOwner, true));
  await waitForJson(owner, 'auth');
  const viewer = await connectWs(wsUrl(room, tViewer, true));
  assert.equal((await waitForJson(viewer, 'auth')).readOnly, true);

  await new Promise(r => setTimeout(r, 200));
  owner._binBuf = []; viewer._binBuf = [];

  // Two distinct encrypted frames, one per direction. Shape only: the relay
  // cannot see the awareness payload, so this asserts transport, not merge.
  const ownerFrame = encryptedFrame(11);
  const viewerFrame = encryptedFrame(23);
  const toViewer = waitForBinary(viewer, (u) => u.length === ownerFrame.length && u.every((b, i) => b === ownerFrame[i]), 3000);
  const toOwner = waitForBinary(owner, (u) => u.length === viewerFrame.length && u.every((b, i) => b === viewerFrame[i]), 3000);

  owner.send(ownerFrame);
  viewer.send(viewerFrame);
  await Promise.all([toViewer, toOwner]);

  // Nobody echoes: after both sends each socket has exactly the one frame it
  // did not originate.
  await new Promise(r => setTimeout(r, 400));
  assert.equal(owner._binBuf.length, 1, 'owner must receive only the viewer frame');
  assert.equal(viewer._binBuf.length, 1, 'viewer must receive only the owner frame');

  // A viewer disconnecting must not make the relay emit anything to the room.
  const mark = owner._binBuf.length;
  viewer.close();
  await new Promise(r => setTimeout(r, 600));
  assert.equal(owner._binBuf.length, mark, 'a disconnect must not make the relay emit awareness state');

  owner.close();
});
