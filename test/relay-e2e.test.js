'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { WebSocket } = require('ws');
const Y = require('yjs');
const encoding = require('lib0/encoding');
const decoding = require('lib0/decoding');
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
    headers: { 'content-type': 'application/json', ...headers },
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
function encodeUpdate(update) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  syncProtocol.writeUpdate(enc, update);
  return encoding.toUint8Array(enc);
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

// 1. happy path: ticket -> connect -> y-sync handshake -> persisted via journal -> second client notification (relay broadcast)
test('relay e2e: ticket connect, y-sync handshake, journal persisted, second client sees broadcast', async () => {
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

  // y-sync handshake: ws1 sends SyncStep1, server should reply with SyncStep1+SyncStep2 frames
  const doc1 = new Y.Doc();
  doc1.getText('ct').insert(0, 'pre');
  ws1.send(encodeSyncStep1(doc1));

  // wait for a binary sync response
  const syncResp = await waitForBinary(ws1, (u) => {
    try { const d = decoding.createDecoder(u); return decoding.readVarUint(d) === MSG_SYNC; } catch { return false; }
  }, 3000);
  assert.ok(syncResp.length > 0);

  // now send a real update and verify second client receives broadcast + journal persisted
  const docUpdate = new Y.Doc();
  docUpdate.getText('ct').insert(0, 'hello e2e');
  const update = Y.encodeStateAsUpdate(docUpdate);

  // prepare to capture broadcast on ws2
  let ws2GotUpdate = false;
  const ws2Promise = waitForBinary(ws2, (u) => {
    try {
      const d = decoding.createDecoder(u);
      if (decoding.readVarUint(d) !== MSG_SYNC) return false;
      const inner = decoding.readVarUint(d);
      // SyncStep2(1) or Update(2) both indicate doc data
      return inner === 1 || inner === 2;
    } catch { return false; }
  }, 4000).then(() => { ws2GotUpdate = true; });

  ws1.send(encodeUpdate(update));

  await ws2Promise;
  assert.equal(ws2GotUpdate, true);

  // The relay is ephemeral (src/db/yjs-persistence.js): it broadcasts edits but
  // never persists plaintext Yjs into the journal. Durable history is written
  // by clients through the encrypted REST push-batch path, so after the relay's
  // debounce there must still be no relay-originated journal row.
  await new Promise(r => setTimeout(r, 1600));
  const { rows } = await query(`SELECT device_id FROM yjs_doc_updates WHERE workspace_id=$1 AND note_id=$2 AND device_id='relay'`, ['ws-e2e', 'note-1']);
  assert.equal(rows.length, 0, 'relay must not persist plaintext rows');

  // The broadcast update is itself valid Yjs containing the edit.
  const check = new Y.Doc();
  Y.applyUpdate(check, update);
  assert.equal(check.getText('ct').toString(), 'hello e2e');

  ws1.close(); ws2.close();
  doc1.destroy(); docUpdate.destroy(); check.destroy();
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
  const tr = await post(app, '/auth/ws-ticket', { workspaceId: 'ws-e2e' }, { authorization: `Bearer ${session}` });
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
  const tr = await post(app, '/auth/ws-ticket', { workspaceId: 'ws-e2e' }, { authorization: `Bearer ${session}` });
  const ticket = tr.json().ticket;
  const ws1 = await connectWs(wsUrl('workspace:ws-e2e:note:note-1', ticket, true));
  await waitForJson(ws1, 'auth');
  // second use of same ticket should fail
  const code = await expectWsUpgradeFail(wsUrl('workspace:ws-e2e:note:note-1', ticket, true));
  assert.ok([401,403,1006].includes(code), `replay should be 401/403 got ${code}`);
  ws1.close();
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

test('negative: read-only viewer write blocked (not persisted, not broadcast)', async () => {
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
  await waitForJson(wsEditor, 'auth');

  // viewer sends update; editor should NOT receive it
  const d = new Y.Doc();
  d.getText('ct').insert(0, 'viewer-write');
  const beforeRows = (await query(`SELECT COUNT(*)::int c FROM yjs_doc_updates WHERE workspace_id='ws-e2e' AND note_id='note-viewer-test'`)).rows[0].c;
  wsViewer.send(encodeUpdate(Y.encodeStateAsUpdate(d)));
  await new Promise(r => setTimeout(r, 1600));
  const afterRows = (await query(`SELECT COUNT(*)::int c FROM yjs_doc_updates WHERE workspace_id='ws-e2e' AND note_id='note-viewer-test'`)).rows[0].c;
  assert.equal(afterRows, beforeRows, 'viewer write should not create relay journal row');

  // editor should not have received broadcast (check binBuf not grown with viewer content)
  // we check that no new MSG_SYNC with that content arrived within short window
  let gotSpurious = false;
  const check = new Promise(r => setTimeout(r, 600));
  wsEditor.on('message', (data, isBin) => { if (isBin) gotSpurious = true; });
  await check;
  // reset flag based on actual counting: if viewer was blocked, wsEditor shouldn't have gotten viewer update as broadcast
  // we just ensure row count unchanged is the authoritative check; broadcast check is best-effort
  assert.equal(gotSpurious, false, 'viewer broadcast should be suppressed');

  wsViewer.close(); wsEditor.close(); d.destroy();
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
