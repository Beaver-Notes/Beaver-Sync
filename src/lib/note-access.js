'use strict';

const { query } = require('../db');

// The workspace a note lives in, from whichever row knows it (same resolution
// order the collaboration routes use). Null when the note is outside a
// workspace.
async function noteWorkspaceId(noteId) {
  const invite = await query(
    `SELECT workspace_id FROM note_invitations WHERE note_id = $1 AND workspace_id IS NOT NULL LIMIT 1`,
    [noteId]
  );
  if (invite.rows[0]?.workspace_id) return invite.rows[0].workspace_id;
  const state = await query(
    `SELECT workspace_id FROM sync_document_state WHERE note_id = $1 LIMIT 1`,
    [noteId]
  );
  if (state.rows[0]?.workspace_id) return state.rows[0].workspace_id;
  const journal = await query(
    `SELECT workspace_id FROM yjs_doc_updates WHERE note_id = $1 ORDER BY created_at DESC, ts DESC LIMIT 1`,
    [noteId]
  );
  return journal.rows[0]?.workspace_id ?? null;
}

// A workspace member's role there, or null. The owner row is not always
// mirrored in workspace_members, so both tables are consulted.
async function workspaceRole(workspaceId, userId) {
  const { rows } = await query(
    `SELECT role FROM workspace_members WHERE workspace_id = $1 AND account_id = $2
     UNION ALL SELECT 'owner' FROM workspaces WHERE id = $1 AND owner_id = $2
     LIMIT 1`,
    [workspaceId, userId]
  );
  return rows[0]?.role ?? null;
}

// Everyone who may read a note's content: its explicit collaborators plus the
// people of the workspace it lives in. A team note carries an invitation row
// only for its creator, so key distribution must not stop at that row.
async function noteAudienceIds(noteId) {
  const workspaceId = await noteWorkspaceId(noteId);
  if (!workspaceId) return [];
  const { rows } = await query(
    `SELECT account_id FROM workspace_members WHERE workspace_id = $1
     UNION SELECT owner_id FROM workspaces WHERE id = $1`,
    [workspaceId]
  );
  return rows.map((r) => r.account_id);
}

// The workspace vocabulary (owner, admin, editor, viewer, guest) read by the
// client too, mapped onto the two roles a note understands: 'editor' writes,
// 'viewer' reads. Mirror of utils/permissions.canEdit plus the client's
// workspace fallback, so a guest is read-only on both sides.
function noteRole(workspaceRole) {
  return workspaceRole === 'viewer' || workspaceRole === 'guest' ? 'viewer' : 'editor';
}

// A note collaborator, direct or by virtue of the note's workspace: a team note
// carries no invitation row per member, only the creator's, so membership is the
// same grant. The returned role speaks the note-level vocabulary so callers can
// keep asking isEditor().
async function resolveNoteAccess(noteId, userId, invite = null) {
  if (invite) return invite;
  const workspaceId = await noteWorkspaceId(noteId);
  if (!workspaceId) return null;
  const role = await workspaceRole(workspaceId, userId);
  if (!role) return null;
  return { noteId, userId, workspaceId, role: noteRole(role) };
}

module.exports = { noteWorkspaceId, noteAudienceIds, workspaceRole, resolveNoteAccess };
