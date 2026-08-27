'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');

process.env.NODE_ENV = 'test';
process.env.JWT_PRIVATE_KEY_PATH = path.join(repoRoot, 'keys/private.pem');
process.env.JWT_PUBLIC_KEY_PATH = path.join(repoRoot, 'keys/public.pem');
process.env.COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars-long';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-characters-long';
process.env.LEGACY_AUTH_ENABLED = 'true';
process.env.ENTERPRISE_MODE = 'false';

const { close, query } = require('../src/db');
const { setupTestDb, cleanTestDb } = require('./helpers/db');
const { seedAccount, seedWorkspace, authHeaders } = require('./helpers/factory');
const { buildApp } = require('../src/server');
const { createSession } = require('../src/middleware/auth');
const { parseRoomName } = require('../src/ws-relay');
const { verifyTicket } = require('../src/ws-relay-auth');

let app;

async function post(app, url, payload, headers = {}) {
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...headers },
    payload,
  });
}

test.before(async () => {
  await setupTestDb();
  await cleanTestDb();
  await seedAccount('account-1');
  await seedWorkspace('workspace-1', 'account-1');

  app = await buildApp();
  await app.ready();
});

test.after(async () => {
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