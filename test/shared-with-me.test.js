'use strict';

// "Shared with me": an account invited to a single note (a note collaborator
// who is NOT a member of the workspace that holds the note) can (a) list the
// notes it was invited to and (b) push/pull ONLY those notes, without being
// granted workspace membership. A non-invited account stays refused, and an
// invitation cannot be used to touch the same note id in another workspace.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.NODE_ENV = 'test';
process.env.COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars-long';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-chars-long';
process.env.ENTERPRISE_MODE = 'false';

const { query } = require('../src/db');
const { setupTestDb, cleanTestDb } = require('./helpers/db');
const { register, authHeaders } = require('./helpers/factory');
const { buildApp } = require('../src/server');

test.before(async () => {
  await setupTestDb();
  await cleanTestDb();
});

test.after(async () => {
  await cleanTestDb();
});

async function seedWorkspace(tag, plan = 'pro') {
  const owner = await register(plan, { email: `${tag}-owner@test.example` });
  const wsId = `ws-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await query(
    'INSERT INTO workspaces (id, name_encrypted, owner_id, created_at) VALUES ($1,$2,$3,$4)',
    [wsId, 'e', owner.id, now]
  );
  await query(
    'INSERT INTO workspace_members (workspace_id, account_id, role, created_at) VALUES ($1,$2,$3,$4)',
    [wsId, owner.id, 'owner', now]
  );
  return { owner, wsId };
}

async function seedInvitation(noteId, userId, invitedBy, role = 'editor') {
  await query(
    'INSERT INTO note_invitations (note_id, user_id, invited_by, role, created_at) VALUES ($1,$2,$3,$4,$5)',
    [noteId, userId, invitedBy, role, new Date().toISOString()]
  );
}

// A note is "owned" by a workspace when its journal row exists there.
async function seedNoteInWorkspace(workspaceId, noteId) {
  await query(
    `INSERT INTO yjs_doc_updates (id, workspace_id, note_id, update_data, update_encrypted, device_id, clock, ts, created_at)
     VALUES ($1,$2,$3,$4,1,'seed-device',1,1,$5)`,
    [`seed-${crypto.randomUUID()}`, workspaceId, noteId, Buffer.from('x'), new Date().toISOString()]
  );
}

function pushBody(workspaceId, noteId, deviceId = 'device-a') {
  return {
    workspaceId,
    notes: [{
      noteId,
      updates: [{
        key: `${noteId}~~${deviceId}~~10~~1.yjs.json`,
        data: 'eA==',
        deviceId,
        sequence: 1,
        ts: 10,
      }],
    }],
  };
}

function pullBody(workspaceId, noteId) {
  return {
    workspaceId,
    notes: [{ noteId, checkpoint: {}, limit: 100 }],
  };
}

async function req(app, method, url, headers, payload, deviceId = 'device-a') {
  return app.inject({
    method,
    url,
    headers: { ...headers, 'x-device-id': deviceId },
    payload,
  });
}

test('shared-with-me lists exactly the caller\'s note invitations with the owning workspace', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const { owner, wsId } = await seedWorkspace('swm-list');
  const invitee = await register('pro', { email: 'swm-list-invitee@test.example' });
  const noteId = `note-${crypto.randomUUID()}`;
  await seedNoteInWorkspace(wsId, noteId);
  await seedInvitation(noteId, invitee.id, owner.id, 'viewer');

  const headers = await authHeaders(invitee.id);
  const res = await req(app, 'GET', '/collaboration/shared-with-me', headers, undefined);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.shared.length, 1);
  assert.equal(body.shared[0].noteId, noteId);
  assert.equal(body.shared[0].role, 'viewer');
  assert.equal(body.shared[0].workspaceId, wsId);

  // Another account sees nothing.
  const stranger = await register('pro', { email: 'swm-list-stranger@test.example' });
  const strangerRes = await req(app, 'GET', '/collaboration/shared-with-me', await authHeaders(stranger.id), undefined);
  assert.equal(strangerRes.json().shared.length, 0);
});

test('an invited non-member can pull and push the invited note', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const { owner, wsId } = await seedWorkspace('swm-sync');
  const invitee = await register('pro', { email: 'swm-sync-invitee@test.example' });
  const noteId = `note-${crypto.randomUUID()}`;
  await seedNoteInWorkspace(wsId, noteId);
  await seedInvitation(noteId, invitee.id, owner.id, 'editor');

  const headers = await authHeaders(invitee.id);

  const pull = await req(app, 'POST', '/yjs/pull-batch', headers, pullBody(wsId, noteId));
  assert.equal(pull.statusCode, 200);
  assert.ok(pull.json().notes[noteId], 'invited peer must be able to pull the note');

  const push = await req(app, 'POST', '/yjs/push-batch', headers, pushBody(wsId, noteId));
  assert.equal(push.statusCode, 201, `expected 201, got ${push.statusCode}: ${push.body}`);
  assert.equal(push.json().accepted, 1);
});

test('a non-invited account is still refused for the note', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const { wsId } = await seedWorkspace('swm-outsider');
  const outsider = await register('pro', { email: 'swm-outsider@test.example' });
  const noteId = `note-${crypto.randomUUID()}`;
  await seedNoteInWorkspace(wsId, noteId);

  const headers = await authHeaders(outsider.id);
  const pull = await req(app, 'POST', '/yjs/pull-batch', headers, pullBody(wsId, noteId));
  assert.equal(pull.statusCode, 403);
  const push = await req(app, 'POST', '/yjs/push-batch', headers, pushBody(wsId, noteId));
  assert.equal(push.statusCode, 403);
});

test('an invitation cannot touch the same note id in a workspace it does not live in', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const real = await seedWorkspace('swm-real');
  const other = await seedWorkspace('swm-other');
  const invitee = await register('pro', { email: 'swm-mismatch@test.example' });
  const noteId = `note-${crypto.randomUUID()}`;
  await seedNoteInWorkspace(real.wsId, noteId); // note lives in `real`
  await seedInvitation(noteId, invitee.id, real.owner.id, 'editor');

  const headers = await authHeaders(invitee.id);
  // caller is invited to the note but names the OTHER workspace it does not own.
  const push = await req(app, 'POST', '/yjs/push-batch', headers, pushBody(other.wsId, noteId));
  assert.equal(push.statusCode, 403);
  assert.equal(push.json().error, 'note_workspace_mismatch');
});

test('a mixed batch is refused unless every note is invited', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const { owner, wsId } = await seedWorkspace('swm-mixed');
  const invitee = await register('pro', { email: 'swm-mixed-invitee@test.example' });
  const invitedNote = `note-${crypto.randomUUID()}`;
  const otherNote = `note-${crypto.randomUUID()}`;
  await seedNoteInWorkspace(wsId, invitedNote);
  await seedNoteInWorkspace(wsId, otherNote);
  await seedInvitation(invitedNote, invitee.id, owner.id, 'editor');

  const headers = await authHeaders(invitee.id);
  const body = {
    workspaceId: wsId,
    notes: [
      { noteId: invitedNote, updates: [{ key: `${invitedNote}~~device-a~~10~~1.yjs.json`, data: 'eA==', deviceId: 'device-a', sequence: 1, ts: 10 }] },
      { noteId: otherNote, updates: [{ key: `${otherNote}~~device-a~~10~~1.yjs.json`, data: 'eA==', deviceId: 'device-a', sequence: 1, ts: 10 }] },
    ],
  };
  const push = await req(app, 'POST', '/yjs/push-batch', headers, body);
  assert.equal(push.statusCode, 403);
});
