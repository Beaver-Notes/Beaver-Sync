'use strict';

// Contract tests for the ws-relay <-> api auth boundary:
//   POST /auth/verify-session, POST /auth/ws-ticket, POST /auth/verify-ticket,
//   POST /sso/exchange.
// INTERNAL_API_SECRET is read per-request inside the handlers, so the set/unset
// branches both run in one process by flipping process.env.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.NODE_ENV = 'test';
process.env.COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars-long';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-characters-long';
process.env.LEGACY_AUTH_ENABLED = 'true';
process.env.ENTERPRISE_MODE = 'false';
// Boundary endpoints are hit many times below; keep limits out of the way.
process.env.VERIFY_SESSION_RATE_LIMIT_PER_MINUTE = '1000';
process.env.WS_TICKET_RATE_LIMIT_PER_MINUTE = '1000';

const { close, getDb } = require('../src/db');
const { setupTestDb, cleanTestDb } = require('./helpers/db');
const { register, seedAccount, seedWorkspace } = require('./helpers/factory');
const { buildApp } = require('../src/server');
const { createSession } = require('../src/middleware/auth');
const models = require('../src/models');

const SECRET = 'contract-test-internal-secret';
// The relay auth endpoints 503 unless this is set; setupTestDb() pins a value and
// every call below presents it.
process.env.INTERNAL_API_SECRET = SECRET;

let app;

// `x-internal-secret: undefined` is how a case asks for no header at all.
function post(body, headers = {}) {
  const merged = { 'content-type': 'application/json', 'x-internal-secret': SECRET, ...headers };
  for (const [k, v] of Object.entries(merged)) if (v === undefined) delete merged[k];
  return app.inject({ method: 'POST', url: '/auth/verify-session', headers: merged, payload: body });
}

test.before(async () => {
  await setupTestDb();
  await cleanTestDb();
  await seedAccount('contract-user');
  await seedWorkspace('contract-ws', 'contract-user');

  app = await buildApp();
  await app.ready();
});

test.after(async () => {
  await app.close();
  await close();
});

// --- Happy paths with the internal secret presented --------------------------

test('valid session + workspaceId returns { userId, role, deviceId }', async () => {
  const token = await createSession('contract-user', { headers: { 'x-device-id': 'contract-device' } });
  const res = await post({ token, workspaceId: 'contract-ws' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { userId: 'contract-user', role: 'owner', deviceId: 'contract-device' });
});

test('valid session without workspaceId/noteId returns userId and deviceId', async () => {
  const token = await createSession('contract-user', { headers: { 'x-device-id': 'contract-device' } });
  const res = await post({ token });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { userId: 'contract-user', deviceId: 'contract-device' });
});

test('noteId-only: viewer stays viewer, non-viewer becomes editor, outsider 403', async () => {
  await models.NoteInvitation.create({
    noteId: 'contract-note-v', userId: 'contract-user', invitedBy: 'contract-user', role: 'viewer', createdAt: new Date(),
  });
  const viewerToken = await createSession('contract-user', { headers: { 'x-device-id': 'contract-device' } });

  const viewer = await post({ token: viewerToken, noteId: 'contract-note-v' });
  assert.equal(viewer.statusCode, 200);
  assert.deepEqual(viewer.json(), { userId: 'contract-user', role: 'viewer', deviceId: 'contract-device' });

  await models.NoteInvitation.create({
    noteId: 'contract-note-e', userId: 'contract-user', invitedBy: 'contract-user', role: 'editor', createdAt: new Date(),
  });
  const editor = await post({ token: viewerToken, noteId: 'contract-note-e' });
  assert.equal(editor.statusCode, 200);
  assert.deepEqual(editor.json(), { userId: 'contract-user', role: 'editor', deviceId: 'contract-device' });

  const outsider = await registerOutsider();
  const res = await post({ token: outsider.token, noteId: 'contract-note-e' });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'forbidden');
});

test('unknown token returns 401 invalid_token', async () => {
  const res = await post({ token: crypto.randomBytes(32).toString('base64url') });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, 'invalid_token');
});

test('missing body token returns 400 invalid_request', async () => {
  const res = await post({});
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'invalid_request');
});

test('missing/incorrect x-internal-secret is 403, correct passes', async () => {
  try {
    const token = await createSession('contract-user', {});

    const noHeader = await post({ token, workspaceId: 'contract-ws' }, { 'x-internal-secret': undefined });
    assert.equal(noHeader.statusCode, 403);
    assert.equal(noHeader.json().error, 'forbidden');

    const wrongHeader = await post(
      { token, workspaceId: 'contract-ws' },
      { 'x-internal-secret': 'wrong-secret' }
    );
    assert.equal(wrongHeader.statusCode, 403);

    const ok = await post(
      { token, workspaceId: 'contract-ws' },
      { 'x-internal-secret': SECRET }
    );
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(ok.json(), { userId: 'contract-user', role: 'owner', deviceId: null });
  } finally {
    // The relay auth endpoints 503 unless this is set; setupTestDb() pins a value, and
// every call below presents it.
process.env.INTERNAL_API_SECRET = SECRET;
  }
});

// --- ws-ticket issue/redeem ---------------------------------------------------

test('ws-ticket + verify-ticket round trip; redemption is single-use', async () => {
  const token = await createSession('contract-user', { headers: { 'x-device-id': 'contract-device' } });

  const issued = await app.inject({
    method: 'POST',
    url: '/auth/ws-ticket',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: { workspaceId: 'contract-ws' },
  });
  assert.equal(issued.statusCode, 200);
  const { ticket } = issued.json();
  assert.ok(ticket && ticket.length >= 16);

  const redeem = await app.inject({
    method: 'POST',
    url: '/auth/verify-ticket',
    headers: { 'content-type': 'application/json', 'x-internal-secret': SECRET },
    payload: { ticket },
  });
  assert.equal(redeem.statusCode, 200);
  const body = redeem.json();
  assert.equal(body.userId, 'contract-user');
  assert.equal(body.role, 'owner');
  assert.equal(body.deviceId, 'contract-device');

  // Single-use: the atomic DELETE ... RETURNING already consumed the row.
  const second = await app.inject({
    method: 'POST',
    url: '/auth/verify-ticket',
    headers: { 'content-type': 'application/json', 'x-internal-secret': SECRET },
    payload: { ticket },
  });
  assert.equal(second.statusCode, 401);
  assert.equal(second.json().error, 'invalid_ticket');
});

test('verify-ticket honors x-internal-secret when set', async () => {
  const token = await createSession('contract-user', { headers: { 'x-device-id': 'contract-device' } });
  const issued = await app.inject({
    method: 'POST',
    url: '/auth/ws-ticket',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: { workspaceId: 'contract-ws' },
  });
  const { ticket } = issued.json();

  process.env.INTERNAL_API_SECRET = SECRET;
  try {
    const denied = await app.inject({
      method: 'POST',
      url: '/auth/verify-ticket',
      headers: { 'content-type': 'application/json' },
      payload: { ticket },
    });
    assert.equal(denied.statusCode, 403);

    const allowed = await app.inject({
      method: 'POST',
      url: '/auth/verify-ticket',
      headers: { 'content-type': 'application/json', 'x-internal-secret': SECRET },
      payload: { ticket },
    });
    assert.equal(allowed.statusCode, 200);
  } finally {
    // The relay auth endpoints 503 unless this is set; setupTestDb() pins a value, and
// every call below presents it.
process.env.INTERNAL_API_SECRET = SECRET;
  }
});

// --- SSO exchange -------------------------------------------------------------

test('POST /sso/exchange rejects an invalid code with 400', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/sso/exchange',
    headers: { 'content-type': 'application/json' },
    payload: { code: 'short-code' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'invalid_code');
});

// A note synced only through the Yjs path has rows in `yjs_doc_updates` and none
// in `sync_document_state`. Checking one table alone refused the ws-ticket, which
// silently cost every invited collaborator realtime and presence.
test('note room in a Yjs-only workspace still authorizes the invited collaborator', async () => {
  const outsider = await registerOutsider();
  await models.NoteInvitation.create({
    noteId: 'contract-yjs-note', userId: outsider.accountId, invitedBy: 'contract-user',
    role: 'editor', createdAt: new Date(),
  });
  // No model object for the journal table; insert the one row the check reads.
  await getDb().query(
    `INSERT INTO yjs_doc_updates (id, workspace_id, note_id, update_data, device_id, clock, ts, created_at)
     VALUES ($1, $2, $3, $4, $5, 0, $6, NOW())`,
    [crypto.randomUUID(), 'contract-ws', 'contract-yjs-note', Buffer.from('x'), 'contract-device', Date.now()]
  );

  const res = await app.inject({
    method: 'POST',
    url: '/auth/ws-ticket',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${outsider.token}` },
    payload: { workspaceId: 'contract-ws', noteId: 'contract-yjs-note' },
  });
  assert.equal(res.statusCode, 200);
  assert.ok(res.json().ticket);
});

async function registerOutsider() {
  const account = await register('pro');
  return { accountId: account.id, token: await createSession(account.id, {}) };
}
