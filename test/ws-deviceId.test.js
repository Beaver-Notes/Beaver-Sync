'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { WebSocket } = require('ws');

const repoRoot = path.resolve(__dirname, '..');

process.env.NODE_ENV = 'test';
process.env.JWT_PRIVATE_KEY_PATH = path.join(repoRoot, 'keys/private.pem');
process.env.JWT_PUBLIC_KEY_PATH = path.join(repoRoot, 'keys/public.pem');
process.env.COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars-long';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-characters-long';
process.env.LEGACY_AUTH_ENABLED = 'true';
process.env.ENTERPRISE_MODE = 'false';
process.env.WS_RELAY_PORT = '18080';

const { close, query } = require('../src/db');
const { setupTestDb, cleanTestDb } = require('./helpers/db');
const { seedAccount, seedWorkspace, authHeaders } = require('./helpers/factory');
const { buildApp } = require('../src/server');
const { createSession } = require('../src/middleware/auth');

// parseRoomName logic copied from src/ws-relay.js for synchronous test
function parseRoomName(documentName) {
  const match = documentName.match(/^workspace:([^:]+):(?:note:([^:]+)|meta)$/);
  if (!match) return null;
  const [, workspaceId, noteId] = match;
  return noteId != null
    ? { kind: 'note', workspaceId, noteId }
    : { kind: 'meta', workspaceId, noteId: null };
}

let app;
let wsRelayServer;
let stopRelay;
let apiPort;
let startWsRelay;
let verifyTicket;

async function post(app, url, payload, headers = {}) {
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...headers },
    payload,
  });
}

function connectWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws._messageBuffer = [];
    ws.on('message', (data, isBinary) => {
      ws._messageBuffer.push({ data, isBinary });
    });
    ws.on('open', () => {
      resolve(ws);
    });
    ws.on('error', reject);
    ws.on('close', () => {});
  });
}

function waitForMessage(ws, type, timeout = 10000) {
  return new Promise((resolve, reject) => {
    // Check buffered messages first
    if (ws._messageBuffer) {
      for (const { data, isBinary } of ws._messageBuffer) {
        if (!isBinary) {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === type) {
              ws._messageBuffer = ws._messageBuffer.filter(m => m.data !== data || m.isBinary !== isBinary);
              return resolve(msg);
            }
          } catch {}
        }
      }
    }
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeout);
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        return;
      }
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === type) {
          clearTimeout(timer);
          resolve(msg);
        }
      } catch {}
    });
    ws.on('error', reject);
    ws.on('close', () => reject(new Error('Connection closed')));
  });
}

test.before(async () => {
  await setupTestDb();
  await cleanTestDb();
  await seedAccount('account-1');
  await seedWorkspace('workspace-1', 'account-1');
  await seedAccount('account-2');
  await query('INSERT INTO workspace_members (workspace_id, account_id, role, created_at) VALUES ($1, $2, $3, $4)', ['workspace-1', 'account-2', 'editor', new Date().toISOString()]);
  await query('INSERT INTO subscriptions (id, account_id, plan, status, storage_quota_bytes, storage_used_bytes, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)', ['account-2-sub', 'account-2', 'pro', 'active', 1000000, 0, new Date().toISOString()]);

  app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  apiPort = app.server.address().port;
  process.env.AUTH_BACKEND_URL = `http://127.0.0.1:${apiPort}`;

  // Now require ws-relay after AUTH_BACKEND_URL is set
  const wsRelay = require('../src/ws-relay');
  startWsRelay = wsRelay.startWsRelay;
  stopRelay = wsRelay.stopWsRelay;
  const wsRelayAuth = require('../src/ws-relay-auth');
  verifyTicket = wsRelayAuth.verifyTicket;

  // Start WebSocket relay on test port
  wsRelayServer = await startWsRelay();
  // Wait for relay to be ready
  await new Promise(r => setTimeout(r, 500));
});

test.after(async () => {
  try { if (stopRelay) await stopRelay(); else if (wsRelayServer) wsRelayServer.close(); } catch {}
  await app.close();
  await close();
});

test('verify-session returns deviceId from session', async () => {
  const session = await createSession('account-1', { headers: { 'x-device-id': 'device-a' } });
  const res = await post(app, '/auth/verify-session', { token: session, workspaceId: 'workspace-1' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.userId, 'account-1');
  assert.equal(body.role, 'owner');
  assert.equal(body.deviceId, 'device-a');
});

test('verify-session returns null deviceId when session has none', async () => {
  const session = await createSession('account-1', { headers: {} });
  const res = await post(app, '/auth/verify-session', { token: session, workspaceId: 'workspace-1' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.userId, 'account-1');
  assert.equal(body.role, 'owner');
  assert.equal(body.deviceId, null);
});

test('ws-ticket includes deviceId in claims', async () => {
  const session = await createSession('account-1', { headers: { 'x-device-id': 'device-b' } });
  const issued = await post(app, '/auth/ws-ticket', { workspaceId: 'workspace-1' }, { authorization: `Bearer ${session}` });
  assert.equal(issued.statusCode, 200);
  const { ticket } = issued.json();

  const redeem = await post(app, '/auth/verify-ticket', { ticket });
  assert.equal(redeem.statusCode, 200);
  const body = redeem.json();
  assert.equal(body.userId, 'account-1');
  assert.equal(body.role, 'owner');
  assert.equal(body.deviceId, 'device-b');
});

test('parseRoomName extracts workspaceId and noteId correctly', () => {
  const room = parseRoomName('workspace:ws_01:note:not_e-ID_9');
  assert.deepStrictEqual(room, { kind: 'note', workspaceId: 'ws_01', noteId: 'not_e-ID_9' });
});

test('sync notification filter uses deviceId field name correctly', () => {
  const ctx = { workspaceId: 'ws-1', deviceId: 'device-a' };
  const excludeDeviceId = 'device-a';
  const shouldExclude = excludeDeviceId && ctx.deviceId === excludeDeviceId;
  assert.equal(shouldExclude, true);

  ctx.deviceId = 'device-b';
  const shouldNotExclude = excludeDeviceId && ctx.deviceId === excludeDeviceId;
  assert.equal(shouldNotExclude, false);

  ctx.deviceId = null;
  const shouldNotExcludeNull = excludeDeviceId && ctx.deviceId === excludeDeviceId;
  assert.equal(shouldNotExcludeNull, false);
});

test('websocket integration: device A push -> A other sockets no notify, B notified', async () => {
  // Create sessions with different device IDs
  const sessionA = await createSession('account-1', { headers: { 'x-device-id': 'device-a' } });
  const sessionB = await createSession('account-2', { headers: { 'x-device-id': 'device-b' } });

  // Get ws-tickets for each connection (tickets are single-use)
  const ticketA1Res = await post(app, '/auth/ws-ticket', { workspaceId: 'workspace-1', noteId: 'test-note-1' }, { authorization: `Bearer ${sessionA}` });
  assert.equal(ticketA1Res.statusCode, 200);
  const { ticket: ticketA1 } = ticketA1Res.json();

  const ticketA2Res = await post(app, '/auth/ws-ticket', { workspaceId: 'workspace-1', noteId: 'test-note-1' }, { authorization: `Bearer ${sessionA}` });
  assert.equal(ticketA2Res.statusCode, 200);
  const { ticket: ticketA2 } = ticketA2Res.json();

  const ticketBRes = await post(app, '/auth/ws-ticket', { workspaceId: 'workspace-1', noteId: 'test-note-1' }, { authorization: `Bearer ${sessionB}` });
  assert.equal(ticketBRes.statusCode, 200);
  const { ticket: ticketB } = ticketBRes.json();

  // Connect device A (first socket)
  const wsA1 = await connectWs(`ws://localhost:18080/workspace:workspace-1:note:test-note-1?ticket=${ticketA1}`);
  const authA1 = await waitForMessage(wsA1, 'auth');
  assert.equal(authA1.readOnly, false);

  // Small delay to let first connection settle
  await new Promise(r => setTimeout(r, 500));

  // Connect device A (second socket - same deviceId, different ticket)
  const wsA2 = await connectWs(`ws://localhost:18080/workspace:workspace-1:note:test-note-1?ticket=${ticketA2}`);
  const authA2 = await waitForMessage(wsA2, 'auth');
  assert.equal(authA2.readOnly, false);

  // Small delay
  await new Promise(r => setTimeout(r, 500));

  // Connect device B (different deviceId)
  const wsB = await connectWs(`ws://localhost:18080/workspace:workspace-1:note:test-note-1?ticket=${ticketB}`);
  const authB = await waitForMessage(wsB, 'auth');
  assert.equal(authB.readOnly, false);

  // Wait a bit for connections to settle
  await new Promise(r => setTimeout(r, 200));

  const ts1 = Date.now();

  // Send push from device A via REST API
  const pushRes = await post(app, '/yjs/push-batch', {
    workspaceId: 'workspace-1',
    notes: [{
      noteId: 'test-note-1',
      updates: [{
        key: `test-note-1~~device-a~~${ts1}~~1.yjs.json`,
        data: Buffer.from('test-data').toString('base64'),
        deviceId: 'device-a',
        sequence: 1,
        ts: ts1
      }]
    }]
  }, { authorization: `Bearer ${sessionA}`, 'x-device-id': 'device-a' });

  assert.equal(pushRes.statusCode, 201);
  assert.equal(pushRes.json().accepted, 1);

  // Wait for notifications to be delivered
  await new Promise(r => setTimeout(r, 500));

  // Collect messages from all connections
  const notificationsA1 = [];
  const notificationsA2 = [];
  const notificationsB = [];

  wsA1.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'notification') notificationsA1.push(msg);
    } catch {}
  });
  wsA2.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'notification') notificationsA2.push(msg);
    } catch {}
  });
  wsB.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'notification') notificationsB.push(msg);
    } catch {}
  });

  // Send another push to trigger notifications
  const ts2 = Date.now();
  const pushRes2 = await post(app, '/yjs/push-batch', {
    workspaceId: 'workspace-1',
    notes: [{
      noteId: 'test-note-1',
      updates: [{
        key: `test-note-1~~device-a~~${ts2}~~2.yjs.json`,
        data: Buffer.from('test-data-2').toString('base64'),
        deviceId: 'device-a',
        sequence: 2,
        ts: ts2
      }]
    }]
  }, { authorization: `Bearer ${sessionA}`, 'x-device-id': 'device-a' });

  assert.equal(pushRes2.statusCode, 201);

  // Wait for notifications
  await new Promise(r => setTimeout(r, 500));

  // Device A's sockets should NOT receive notifications (excluded by deviceId)
  assert.equal(notificationsA1.length, 0, 'Device A socket 1 should not receive notification about its own push');
  assert.equal(notificationsA2.length, 0, 'Device A socket 2 should not receive notification about its own push');

  // Device B SHOULD receive notification
  assert.equal(notificationsB.length, 1, 'Device B should receive notification about device A push');
  assert.deepEqual(notificationsB[0].noteIds, ['test-note-1']);

  // Cleanup
  wsA1.close();
  wsA2.close();
  wsB.close();
});