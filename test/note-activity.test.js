'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.NODE_ENV = 'test';
process.env.COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars-long';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-chars-long';

const { close } = require('../src/db');
const { setupTestDb, cleanTestDb } = require('./helpers/db');
const { register, authHeaders } = require('./helpers/factory');
const { buildApp } = require('../src/server');
const models = require('../src/models');

test.before(async () => { await setupTestDb(); await cleanTestDb(); });
test.after(async () => { await close(); });

// Owner + a second member on a note. The owner is an editor (the server models
// the note owner as an editor invitation); `role` sets the second member.
async function seedNote(role = 'editor') {
  const owner = await register('pro');
  const member = await register('pro');
  const noteId = `note-activity-${crypto.randomBytes(4).toString('hex')}`;
  await models.NoteInvitation.create({ noteId, userId: owner.id, invitedBy: owner.id, role: 'editor', createdAt: new Date() });
  await models.NoteInvitation.create({ noteId, userId: member.id, invitedBy: owner.id, role, createdAt: new Date() });
  return { owner, member, noteId };
}

test('append/list round-trips an opaque payload', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const { owner, noteId } = await seedNote();
  const headers = await authHeaders(owner.id);

  const post = await app.inject({
    method: 'POST',
    url: `/activity/${noteId}`,
    headers,
    payload: { id: 'entry-1', kind: 'insert', contentEncrypted: 'deadbeef', contentIv: 'cafe' },
  });
  assert.equal(post.statusCode, 201, post.body);

  const list = await app.inject({ method: 'GET', url: `/activity/${noteId}`, headers });
  assert.equal(list.statusCode, 200, list.body);
  const rows = list.json().activity;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'entry-1');
  assert.equal(rows[0].noteId, noteId);
  assert.equal(rows[0].authorId, owner.id);
  assert.equal(rows[0].kind, 'insert');
  assert.equal(rows[0].contentEncrypted, 'deadbeef');
  assert.equal(rows[0].contentIv, 'cafe');
});

test('appending the same entry id twice is idempotent', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const { owner, noteId } = await seedNote();
  const headers = await authHeaders(owner.id);
  const payload = { id: 'entry-dup', kind: 'insert', contentEncrypted: 'aa', contentIv: 'bb' };

  const first = await app.inject({ method: 'POST', url: `/activity/${noteId}`, headers, payload });
  assert.equal(first.statusCode, 201, first.body);
  const second = await app.inject({ method: 'POST', url: `/activity/${noteId}`, headers, payload });
  assert.ok(second.statusCode < 300, second.body);

  const list = await app.inject({ method: 'GET', url: `/activity/${noteId}`, headers });
  assert.equal(list.json().activity.length, 1);
});

test('a non-member is refused', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const { noteId } = await seedNote();
  const stranger = await register('pro');
  const headers = await authHeaders(stranger.id);

  const list = await app.inject({ method: 'GET', url: `/activity/${noteId}`, headers });
  assert.equal(list.statusCode, 403, list.body);

  const post = await app.inject({
    method: 'POST',
    url: `/activity/${noteId}`,
    headers,
    payload: { id: 'x', kind: 'insert', contentEncrypted: 'a', contentIv: 'b' },
  });
  assert.equal(post.statusCode, 403, post.body);
});

test('a viewer collaborator can read but not append', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const { owner, member, noteId } = await seedNote('viewer');
  const viewerHeaders = await authHeaders(member.id);

  const list = await app.inject({ method: 'GET', url: `/activity/${noteId}`, headers: viewerHeaders });
  assert.equal(list.statusCode, 200, list.body);

  const post = await app.inject({
    method: 'POST',
    url: `/activity/${noteId}`,
    headers: viewerHeaders,
    payload: { id: 'v', kind: 'insert', contentEncrypted: 'a', contentIv: 'b' },
  });
  assert.equal(post.statusCode, 403, post.body);

  // The owner (editor) can append, proving the gate is role-based not note-wide.
  const ownerPost = await app.inject({
    method: 'POST',
    url: `/activity/${noteId}`,
    headers: await authHeaders(owner.id),
    payload: { id: 'o', kind: 'insert', contentEncrypted: 'a', contentIv: 'b' },
  });
  assert.equal(ownerPost.statusCode, 201, ownerPost.body);
});

test('kind is optional and never stored in the clear: new writes keep it in the payload', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const { owner, noteId } = await seedNote();
  const headers = await authHeaders(owner.id);

  const post = await app.inject({
    method: 'POST',
    url: `/activity/${noteId}`,
    headers,
    payload: { id: 'entry-nokind', contentEncrypted: 'aa', contentIv: 'bb' },
  });
  assert.equal(post.statusCode, 201, post.body);

  const row = await models.NoteActivity.findOne({ _id: 'entry-nokind' }).lean();
  assert.ok(row, 'the opaque row must be stored');
  assert.equal(row.kind, null, 'no readable kind column for a new write');

  const list = await app.inject({ method: 'GET', url: `/activity/${noteId}`, headers });
  const stored = list.json().activity.find((r) => r.id === 'entry-nokind');
  assert.equal(stored.kind, null);
});

test('stores no plaintext: unknown fields are never persisted or returned', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const { owner, noteId } = await seedNote();
  const headers = await authHeaders(owner.id);
  const secret = 'SECRET-PLAINTEXT-SUMMARY';

  const post = await app.inject({
    method: 'POST',
    url: `/activity/${noteId}`,
    headers,
    payload: {
      id: 'entry-secret',
      kind: 'insert',
      contentEncrypted: 'deadbeef',
      contentIv: 'cafe',
      summary: secret,
      anchorHint: secret,
    },
  });
  assert.equal(post.statusCode, 201, post.body);
  assert.ok(!post.body.includes(secret), 'response must not echo plaintext');
  assert.ok(!listBodyIncludes(await app.inject({ method: 'GET', url: `/activity/${noteId}`, headers }), secret));

  const row = await models.NoteActivity.findOne({ _id: 'entry-secret' }).lean();
  assert.ok(row, 'the opaque row must be stored');
  assert.equal(row.contentEncrypted, 'deadbeef');
  assert.ok(!Object.keys(row).some((k) => ['summary', 'anchorHint', 'anchor_hint', 'content', 'text'].includes(k)));
  for (const value of Object.values(row)) {
    assert.ok(!String(value ?? '').includes(secret), 'no column may hold the plaintext');
  }
});

test('prunes the oldest entries past the per-note cap without touching other notes', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const { owner, noteId } = await seedNote();
  const headers = await authHeaders(owner.id);

  const otherNoteId = `note-activity-other-${crypto.randomBytes(4).toString('hex')}`;
  await models.NoteInvitation.create({ noteId: otherNoteId, userId: owner.id, invitedBy: owner.id, role: 'editor', createdAt: new Date() });

  const base = Date.now() - 1_000_000;
  for (let i = 0; i < 200; i += 1) {
    await models.NoteActivity.create({
      id: `cap-${i}`, noteId, authorId: owner.id, kind: null,
      contentEncrypted: 'x', contentIv: 'y',
      createdAt: new Date(base + i * 1000).toISOString(),
    });
  }
  for (let i = 0; i < 3; i += 1) {
    await models.NoteActivity.create({
      id: `other-${i}`, noteId: otherNoteId, authorId: owner.id, kind: null,
      contentEncrypted: 'x', contentIv: 'y',
      createdAt: new Date(base + i * 1000).toISOString(),
    });
  }

  const post = await app.inject({
    method: 'POST',
    url: `/activity/${noteId}`,
    headers,
    payload: { id: 'cap-newest', contentEncrypted: 'aa', contentIv: 'bb' },
  });
  assert.equal(post.statusCode, 201, post.body);

  const rows = (await app.inject({ method: 'GET', url: `/activity/${noteId}`, headers })).json().activity;
  assert.equal(rows.length, 200, 'the note is capped at 200 rows');
  assert.equal(rows[0].id, 'cap-newest');
  assert.ok(!rows.some((r) => r.id === 'cap-0'), 'the oldest row is pruned');
  assert.ok(rows.some((r) => r.id === 'cap-1'), 'the next-oldest survives');

  const otherRows = (await app.inject({ method: 'GET', url: `/activity/${otherNoteId}`, headers })).json().activity;
  assert.equal(otherRows.length, 3, 'another note is untouched');
});

function listBodyIncludes(response, needle) {
  return String(response.body).includes(needle);
}
