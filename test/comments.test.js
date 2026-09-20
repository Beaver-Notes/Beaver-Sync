'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

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

async function seedThread() {
  const author = await register('pro');
  const replier = await register('pro');
  const noteId = 'note-comment-delete';
  await models.NoteInvitation.create({ noteId, userId: author.id, invitedBy: author.id, role: 'editor', createdAt: new Date() });
  await models.NoteInvitation.create({ noteId, userId: replier.id, invitedBy: author.id, role: 'editor', createdAt: new Date() });
  return { author, replier, noteId };
}

test('a new comment write keeps anchors out of the readable columns', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const { author, noteId } = await seedThread();
  const headers = await authHeaders(author.id);

  const res = await app.inject({
    method: 'POST',
    url: `/comments/${noteId}`,
    headers,
    payload: { contentEncrypted: 'opaque', contentIv: 'iv' },
  });
  assert.equal(res.statusCode, 201, res.body);
  const id = res.json().comment.id;
  const row = await models.NoteComment.findOne({ _id: id }).lean();
  assert.equal(row.anchorFrom, null);
  assert.equal(row.anchorTo, null);
});

test('deleting a comment never cascades into another user\'s reply', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const { author, replier, noteId } = await seedThread();
  const authorHeaders = await authHeaders(author.id);
  const replierHeaders = await authHeaders(replier.id);

  const root = await app.inject({ method: 'POST', url: `/comments/${noteId}`, headers: authorHeaders, payload: { contentEncrypted: 'c', contentIv: 'i' } });
  assert.equal(root.statusCode, 201, root.body);
  const rootId = root.json().comment.id;

  const reply = await app.inject({ method: 'POST', url: `/comments/${noteId}`, headers: replierHeaders, payload: { contentEncrypted: 'r', contentIv: 'iv', parentId: rootId } });
  assert.equal(reply.statusCode, 201, reply.body);
  const replyId = reply.json().comment.id;

  const del = await app.inject({ method: 'DELETE', url: `/comments/${rootId}`, headers: authorHeaders });
  assert.equal(del.statusCode, 200, del.body);

  assert.equal(await models.NoteComment.findOne({ _id: rootId }).lean(), null);
  const replyAfter = await models.NoteComment.findOne({ _id: replyId }).lean();
  assert.ok(replyAfter, 'a reply authored by another user must survive the parent delete');
  assert.equal(replyAfter.parentId, rootId);
});

test('a user cannot delete another user\'s comment', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const { author, replier, noteId } = await seedThread();
  const authorHeaders = await authHeaders(author.id);
  const replierHeaders = await authHeaders(replier.id);

  const comment = await app.inject({ method: 'POST', url: `/comments/${noteId}`, headers: authorHeaders, payload: { contentEncrypted: 'c', contentIv: 'i' } });
  const commentId = comment.json().comment.id;

  const del = await app.inject({ method: 'DELETE', url: `/comments/${commentId}`, headers: replierHeaders });
  assert.equal(del.statusCode, 403);
  assert.ok(await models.NoteComment.findOne({ _id: commentId }).lean(), 'the comment must survive');
});
