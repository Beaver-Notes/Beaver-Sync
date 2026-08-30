'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');

const repoRoot = path.resolve(__dirname, '..');
process.env.NODE_ENV = 'test';
process.env.JWT_PRIVATE_KEY_PATH = path.join(repoRoot, 'keys/private.pem');
process.env.JWT_PUBLIC_KEY_PATH = path.join(repoRoot, 'keys/public.pem');
process.env.COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars-long-e2e';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long-e2e';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-characters-long-e2e';
process.env.LEGACY_AUTH_ENABLED = 'true';
process.env.ENTERPRISE_MODE = 'false';

const { close } = require('../src/db');
const { setupTestDb, cleanTestDb } = require('./helpers/db');
const { register, seedOrg } = require('./helpers/factory');
const { buildApp } = require('../src/server');
const models = require('../src/models');
const { signToken } = require('../src/middleware/auth');

test.before(async () => { await setupTestDb(); await cleanTestDb(); });
test.after(async () => { await close(); });

const authHeader = (account) => ({ authorization: `Bearer ${signToken(account.id)}` });

function createPayload(orgId, recipients, overrides = {}) {
  return {
    nameEncrypted: 'enc-workspace-name',
    orgId,
    recipients,
    ...overrides,
  };
}

test('POST /workspaces accepts valid emoji from allowlist', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const owner = await register('pro');
  const orgId = `org-emoji-1-${crypto.randomBytes(4).toString('hex')}`;
  await seedOrg(orgId, owner.id, 'team');

  const res = await app.inject({
    method: 'POST',
    url: '/workspaces',
    headers: { ...authHeader(owner), 'content-type': 'application/json' },
    payload: createPayload(orgId, [{ userId: owner.id, wrappedKey: 'wrapped-owner' }], { emoji: '📁' }),
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().emoji, '📁');
});

test('POST /workspaces accepts valid single-codepoint emoji', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const owner = await register('pro');
  const orgId = `org-emoji-2-${crypto.randomBytes(4).toString('hex')}`;
  await seedOrg(orgId, owner.id, 'team');

  const res = await app.inject({
    method: 'POST',
    url: '/workspaces',
    headers: { ...authHeader(owner), 'content-type': 'application/json' },
    payload: createPayload(orgId, [{ userId: owner.id, wrappedKey: 'wrapped-owner' }], { emoji: '🚀' }),
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().emoji, '🚀');
});

test('POST /workspaces rejects invalid emoji (multi-codepoint not in allowlist)', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const owner = await register('pro');
  const orgId = `org-emoji-3-${crypto.randomBytes(4).toString('hex')}`;
  await seedOrg(orgId, owner.id, 'team');

  const res = await app.inject({
    method: 'POST',
    url: '/workspaces',
    headers: { ...authHeader(owner), 'content-type': 'application/json' },
    payload: createPayload(orgId, [{ userId: owner.id, wrappedKey: 'wrapped-owner' }], { emoji: '👨‍👩‍👧‍👦' }),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'validation_error');
});

test('POST /workspaces accepts valid color from swatches', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const owner = await register('pro');
  const orgId = `org-color-1-${crypto.randomBytes(4).toString('hex')}`;
  await seedOrg(orgId, owner.id, 'team');

  const res = await app.inject({
    method: 'POST',
    url: '/workspaces',
    headers: { ...authHeader(owner), 'content-type': 'application/json' },
    payload: createPayload(orgId, [{ userId: owner.id, wrappedKey: 'wrapped-owner' }], { color: '#6366f1' }),
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().color, '#6366f1');
});

test('POST /workspaces rejects invalid color (not in swatches)', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const owner = await register('pro');
  const orgId = `org-color-2-${crypto.randomBytes(4).toString('hex')}`;
  await seedOrg(orgId, owner.id, 'team');

  const res = await app.inject({
    method: 'POST',
    url: '/workspaces',
    headers: { ...authHeader(owner), 'content-type': 'application/json' },
    payload: createPayload(orgId, [{ userId: owner.id, wrappedKey: 'wrapped-owner' }], { color: '#ff0000' }),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'validation_error');
});

test('POST /workspaces uses default emoji and color when omitted', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const owner = await register('pro');
  const orgId = `org-default-1-${crypto.randomBytes(4).toString('hex')}`;
  await seedOrg(orgId, owner.id, 'team');

  const res = await app.inject({
    method: 'POST',
    url: '/workspaces',
    headers: { ...authHeader(owner), 'content-type': 'application/json' },
    payload: createPayload(orgId, [{ userId: owner.id, wrappedKey: 'wrapped-owner' }]),
  });
  assert.equal(res.statusCode, 201);
  assert.ok(res.json().emoji);
  assert.ok(res.json().color);
  assert.equal(res.json().emoji, '📁');
  assert.equal(res.json().color, '#6366f1');
});

test('PATCH /workspaces/:id updates emoji only', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const owner = await register('pro');
  const orgId = `org-patch-1-${crypto.randomBytes(4).toString('hex')}`;
  await seedOrg(orgId, owner.id, 'team');

  const createRes = await app.inject({
    method: 'POST',
    url: '/workspaces',
    headers: { ...authHeader(owner), 'content-type': 'application/json' },
    payload: createPayload(orgId, [{ userId: owner.id, wrappedKey: 'wrapped-owner' }]),
  });
  const workspaceId = createRes.json().id;

  const patchRes = await app.inject({
    method: 'PATCH',
    url: `/workspaces/${workspaceId}`,
    headers: { ...authHeader(owner), 'content-type': 'application/json' },
    payload: { emoji: '🎨' },
  });
  assert.equal(patchRes.statusCode, 200);
  assert.equal(patchRes.json().emoji, '🎨');
  assert.equal(patchRes.json().color, '#6366f1'); // unchanged
});

test('PATCH /workspaces/:id updates color only', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const owner = await register('pro');
  const orgId = `org-patch-2-${crypto.randomBytes(4).toString('hex')}`;
  await seedOrg(orgId, owner.id, 'team');

  const createRes = await app.inject({
    method: 'POST',
    url: '/workspaces',
    headers: { ...authHeader(owner), 'content-type': 'application/json' },
    payload: createPayload(orgId, [{ userId: owner.id, wrappedKey: 'wrapped-owner' }]),
  });
  const workspaceId = createRes.json().id;

  const patchRes = await app.inject({
    method: 'PATCH',
    url: `/workspaces/${workspaceId}`,
    headers: { ...authHeader(owner), 'content-type': 'application/json' },
    payload: { color: '#ef4444' },
  });
  assert.equal(patchRes.statusCode, 200);
  assert.equal(patchRes.json().color, '#ef4444');
  assert.equal(patchRes.json().emoji, '📁'); // unchanged
});

test('PATCH /workspaces/:id updates both emoji and color', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const owner = await register('pro');
  const orgId = `org-patch-3-${crypto.randomBytes(4).toString('hex')}`;
  await seedOrg(orgId, owner.id, 'team');

  const createRes = await app.inject({
    method: 'POST',
    url: '/workspaces',
    headers: { ...authHeader(owner), 'content-type': 'application/json' },
    payload: createPayload(orgId, [{ userId: owner.id, wrappedKey: 'wrapped-owner' }]),
  });
  const workspaceId = createRes.json().id;

  const patchRes = await app.inject({
    method: 'PATCH',
    url: `/workspaces/${workspaceId}`,
    headers: { ...authHeader(owner), 'content-type': 'application/json' },
    payload: { emoji: '🚀', color: '#22c55e' },
  });
  assert.equal(patchRes.statusCode, 200);
  assert.equal(patchRes.json().emoji, '🚀');
  assert.equal(patchRes.json().color, '#22c55e');
});

test('PATCH /workspaces/:id updates nameEncrypted along with emoji/color', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const owner = await register('pro');
  const orgId = `org-patch-4-${crypto.randomBytes(4).toString('hex')}`;
  await seedOrg(orgId, owner.id, 'team');

  const createRes = await app.inject({
    method: 'POST',
    url: '/workspaces',
    headers: { ...authHeader(owner), 'content-type': 'application/json' },
    payload: createPayload(orgId, [{ userId: owner.id, wrappedKey: 'wrapped-owner' }]),
  });
  const workspaceId = createRes.json().id;

  const patchRes = await app.inject({
    method: 'PATCH',
    url: `/workspaces/${workspaceId}`,
    headers: { ...authHeader(owner), 'content-type': 'application/json' },
    payload: { nameEncrypted: 'new-enc-name', emoji: '📝', color: '#f59e0b' },
  });
  assert.equal(patchRes.statusCode, 200);
  assert.equal(patchRes.json().nameEncrypted, 'new-enc-name');
  assert.equal(patchRes.json().emoji, '📝');
  assert.equal(patchRes.json().color, '#f59e0b');
});

test('PATCH /workspaces/:id rejects when no fields provided', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const owner = await register('pro');
  const orgId = `org-patch-5-${crypto.randomBytes(4).toString('hex')}`;
  await seedOrg(orgId, owner.id, 'team');

  const createRes = await app.inject({
    method: 'POST',
    url: '/workspaces',
    headers: { ...authHeader(owner), 'content-type': 'application/json' },
    payload: createPayload(orgId, [{ userId: owner.id, wrappedKey: 'wrapped-owner' }]),
  });
  const workspaceId = createRes.json().id;

  const patchRes = await app.inject({
    method: 'PATCH',
    url: `/workspaces/${workspaceId}`,
    headers: { ...authHeader(owner), 'content-type': 'application/json' },
    payload: {},
  });
  assert.equal(patchRes.statusCode, 400);
  assert.equal(patchRes.json().error, 'validation_error');
});

test('PATCH /workspaces/:id rejects invalid emoji', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const owner = await register('pro');
  const orgId = `org-patch-6-${crypto.randomBytes(4).toString('hex')}`;
  await seedOrg(orgId, owner.id, 'team');

  const createRes = await app.inject({
    method: 'POST',
    url: '/workspaces',
    headers: { ...authHeader(owner), 'content-type': 'application/json' },
    payload: createPayload(orgId, [{ userId: owner.id, wrappedKey: 'wrapped-owner' }]),
  });
  const workspaceId = createRes.json().id;

  const patchRes = await app.inject({
    method: 'PATCH',
    url: `/workspaces/${workspaceId}`,
    headers: { ...authHeader(owner), 'content-type': 'application/json' },
    payload: { emoji: 'invalid' },
  });
  assert.equal(patchRes.statusCode, 400);
  assert.equal(patchRes.json().error, 'validation_error');
});

test('PATCH /workspaces/:id rejects invalid color', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const owner = await register('pro');
  const orgId = `org-patch-7-${crypto.randomBytes(4).toString('hex')}`;
  await seedOrg(orgId, owner.id, 'team');

  const createRes = await app.inject({
    method: 'POST',
    url: '/workspaces',
    headers: { ...authHeader(owner), 'content-type': 'application/json' },
    payload: createPayload(orgId, [{ userId: owner.id, wrappedKey: 'wrapped-owner' }]),
  });
  const workspaceId = createRes.json().id;

  const patchRes = await app.inject({
    method: 'PATCH',
    url: `/workspaces/${workspaceId}`,
    headers: { ...authHeader(owner), 'content-type': 'application/json' },
    payload: { color: 'not-a-color' },
  });
  assert.equal(patchRes.statusCode, 400);
  assert.equal(patchRes.json().error, 'validation_error');
});

test('PATCH /workspaces/:id forbidden for non-owner/admin', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const owner = await register('pro');
  const member = await register('pro');
  const orgId = `org-patch-8-${crypto.randomBytes(4).toString('hex')}`;
  await seedOrg(orgId, owner.id, 'team');

  const createRes = await app.inject({
    method: 'POST',
    url: '/workspaces',
    headers: { ...authHeader(owner), 'content-type': 'application/json' },
    payload: createPayload(orgId, [{ userId: owner.id, wrappedKey: 'wrapped-owner' }]),
  });
  const workspaceId = createRes.json().id;

  await models.WorkspaceMember.create({ workspaceId, accountId: member.id, role: 'editor', createdAt: new Date() });

  const patchRes = await app.inject({
    method: 'PATCH',
    url: `/workspaces/${workspaceId}`,
    headers: { ...authHeader(member), 'content-type': 'application/json' },
    payload: { emoji: '🎨' },
  });
  assert.equal(patchRes.statusCode, 403);
});

test('GET /workspaces returns emoji and color for all workspaces', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const owner = await register('pro');
  const orgId = `org-list-1-${crypto.randomBytes(4).toString('hex')}`;
  await seedOrg(orgId, owner.id, 'team');

  await app.inject({
    method: 'POST',
    url: '/workspaces',
    headers: { ...authHeader(owner), 'content-type': 'application/json' },
    payload: createPayload(orgId, [{ userId: owner.id, wrappedKey: 'wrapped-owner' }], { emoji: '🎨', color: '#ef4444' }),
  });

  const listRes = await app.inject({ method: 'GET', url: '/workspaces', headers: authHeader(owner) });
  assert.equal(listRes.statusCode, 200);
  const ws = listRes.json().workspaces[0];
  assert.equal(ws.emoji, '🎨');
  assert.equal(ws.color, '#ef4444');
});