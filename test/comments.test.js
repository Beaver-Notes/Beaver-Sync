'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars-long';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-chars-long';

const { getDb, close } = require('../src/db');
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

// The anchor offsets used to be stored as plaintext BIGINT columns, which told
// the server operator which character range of an unreadable note a comment
// points at. The client now folds them into the encrypted payload instead, so
// the columns are gone and the request body fields are ignored for backward
// compatibility with older clients.
test('comment anchors live inside the encrypted payload, not in columns', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const { author, noteId } = await seedThread();
  const headers = await authHeaders(author.id);

  const res = await app.inject({
    method: 'POST',
    url: `/comments/${noteId}`,
    headers,
    payload: { contentEncrypted: 'opaque', contentIv: 'iv', anchorFrom: 12, anchorTo: 40 },
  });
  assert.equal(res.statusCode, 201, res.body, 'extra anchor fields must be ignored, not rejected');
  assert.equal(res.json().comment.anchorFrom, undefined);
  assert.equal(res.json().comment.anchorTo, undefined);

  const cols = await getDb().query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'note_comments' AND column_name IN ('anchor_from', 'anchor_to')",
  );
  assert.equal(cols.rows.length, 0, 'the plaintext anchor columns must no longer exist');
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

test('only an editor collaborator can resolve a comment', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const author = await register('pro');
  const viewer = await register('pro');
  const noteId = 'note-comment-resolve-role';
  await models.NoteInvitation.create({ noteId, userId: author.id, invitedBy: author.id, role: 'editor', createdAt: new Date() });
  await models.NoteInvitation.create({ noteId, userId: viewer.id, invitedBy: author.id, role: 'viewer', createdAt: new Date() });
  const authorHeaders = await authHeaders(author.id);
  const viewerHeaders = await authHeaders(viewer.id);

  const comment = await app.inject({ method: 'POST', url: `/comments/${noteId}`, headers: authorHeaders, payload: { contentEncrypted: 'c', contentIv: 'i' } });
  assert.equal(comment.statusCode, 201, comment.body);
  const commentId = comment.json().comment.id;

  const resolve = await app.inject({ method: 'PATCH', url: `/comments/${commentId}/resolve`, headers: viewerHeaders });
  assert.equal(resolve.statusCode, 403, resolve.body);
  assert.equal((await models.NoteComment.findOne({ _id: commentId }).lean()).resolved, 0, 'a viewer must not resolve');

  const unresolve = await app.inject({ method: 'PATCH', url: `/comments/${commentId}/resolve`, headers: viewerHeaders });
  assert.equal(unresolve.statusCode, 403, unresolve.body);

  const byEditor = await app.inject({ method: 'PATCH', url: `/comments/${commentId}/resolve`, headers: authorHeaders });
  assert.equal(byEditor.statusCode, 200, byEditor.body);
  assert.equal(byEditor.json().resolved, true);
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

test('reactions are per-user encrypted rows; any collaborator may react', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const author = await register('pro');
  const viewer = await register('pro');
  const outsider = await register('pro');
  const noteId = 'note-comment-reactions';
  await models.NoteInvitation.create({ noteId, userId: author.id, invitedBy: author.id, role: 'editor', createdAt: new Date() });
  await models.NoteInvitation.create({ noteId, userId: viewer.id, invitedBy: author.id, role: 'viewer', createdAt: new Date() });
  const authorHeaders = await authHeaders(author.id);
  const viewerHeaders = await authHeaders(viewer.id);
  const outsiderHeaders = await authHeaders(outsider.id);

  const viewerIv = '00112233445566778899aabb';
  const authorIv = 'ffeeddccbbaa998877665544';

  const created = await app.inject({ method: 'POST', url: `/comments/${noteId}`, headers: authorHeaders, payload: { contentEncrypted: 'c', contentIv: 'i' } });
  assert.equal(created.statusCode, 201, created.body);
  assert.deepEqual(created.json().comment.reactions, [], 'a new comment starts with no reactions');
  const commentId = created.json().comment.id;

  const missing = await app.inject({ method: 'POST', url: `/comments/${commentId}/reactions`, headers: authorHeaders, payload: {} });
  assert.equal(missing.statusCode, 400, missing.body, 'the encrypted payload is required');

  const badHex = await app.inject({ method: 'POST', url: `/comments/${commentId}/reactions`, headers: authorHeaders, payload: { emojisEncrypted: 'zz', emojisIv: viewerIv } });
  assert.equal(badHex.statusCode, 400, badHex.body, 'non-hex ciphertext must be rejected');

  const forbidden = await app.inject({ method: 'POST', url: `/comments/${commentId}/reactions`, headers: outsiderHeaders, payload: { emojisEncrypted: 'aabb', emojisIv: viewerIv } });
  assert.equal(forbidden.statusCode, 403, forbidden.body, 'non-collaborators must not react');

  const first = await app.inject({ method: 'POST', url: `/comments/${commentId}/reactions`, headers: viewerHeaders, payload: { emojisEncrypted: 'aabb', emojisIv: viewerIv } });
  assert.equal(first.statusCode, 200, first.body, 'a viewer may react');
  assert.deepEqual(first.json().reactions, [{ userId: viewer.id, emojisEncrypted: 'aabb', emojisIv: viewerIv }]);

  const second = await app.inject({ method: 'POST', url: `/comments/${commentId}/reactions`, headers: authorHeaders, payload: { emojisEncrypted: 'ccdd', emojisIv: authorIv } });
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().reactions.length, 2, 'each user owns a separate row');

  const update = await app.inject({ method: 'POST', url: `/comments/${commentId}/reactions`, headers: viewerHeaders, payload: { emojisEncrypted: 'eeff', emojisIv: viewerIv } });
  assert.equal(update.statusCode, 200, update.body);
  assert.equal(update.json().reactions.length, 2, 'updating your own row never touches anyone else');
  const viewerRow = update.json().reactions.find((r) => r.userId === viewer.id);
  assert.equal(viewerRow.emojisEncrypted, 'eeff');
  assert.match(viewerRow.emojisEncrypted, /^[0-9a-f]+$/i, 'the server stores only ciphertext');

  const remove = await app.inject({ method: 'POST', url: `/comments/${commentId}/reactions`, headers: viewerHeaders, payload: { emojisEncrypted: '', emojisIv: '' } });
  assert.equal(remove.statusCode, 200, remove.body);
  assert.deepEqual(remove.json().reactions, [{ userId: author.id, emojisEncrypted: 'ccdd', emojisIv: authorIv }], 'an empty payload removes only the caller');

  const list = await app.inject({ method: 'GET', url: `/comments/${noteId}`, headers: authorHeaders });
  assert.equal(list.statusCode, 200, list.body);
  const listed = list.json().comments.find((c) => c.id === commentId);
  assert.deepEqual(listed.reactions, [{ userId: author.id, emojisEncrypted: 'ccdd', emojisIv: authorIv }]);

  // Reaction rows belong to their comment: FK cascade removes them.
  const del = await app.inject({ method: 'DELETE', url: `/comments/${commentId}`, headers: authorHeaders });
  assert.equal(del.statusCode, 200, del.body);
  assert.equal((await models.NoteCommentReaction.find({ commentId }).lean()).length, 0, 'reactions are deleted with their comment');
});
