'use strict';

// First-registration reconciliation for note collaboration rows.
//
// A note that has not been pushed yet has no provable server-side owner, so the
// invite/link bootstrap accepts a client-asserted workspaceId (owner role). That
// window lets an account that owns SOME workspace plant a collaborator row for a
// guessed note id, which the real owner could later wrap a key for. When the
// note first becomes server-known (first journal/snapshot row binding the
// noteId to its owning workspace) this purges every pre-registration row whose
// creator is not a member of the owning workspace. Legitimate pre-registration
// shares made by a member survive, and rows created after registration are
// never touched because this runs once, at registration.

async function reconcileNoteOwnership(executor, workspaceId, noteIds) {
  const purged = [];
  for (const noteId of noteIds) {
    // Invitations not created by a member of the owning workspace were
    // squatted while the note had no server-side identity.
    const invitations = await executor.query(`
      DELETE FROM note_invitations ni
       WHERE ni.note_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM workspace_members m
            WHERE m.workspace_id = $2 AND m.account_id = ni.invited_by
         )
      RETURNING ni.user_id
    `, [noteId, workspaceId]);

    // Envelopes follow their invitation: drop envelopes held by a non-member
    // with no surviving member-created invitation. A member's own envelope and
    // a legitimately pre-shared external collaborator's envelope survive.
    const keys = await executor.query(`
      DELETE FROM note_keys nk
       WHERE nk.note_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM workspace_members m
            WHERE m.workspace_id = $2 AND m.account_id = nk.user_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM note_invitations ni
            WHERE ni.note_id = nk.note_id AND ni.user_id = nk.user_id
         )
      RETURNING nk.user_id
    `, [noteId, workspaceId]);

    // An invite link minted by a non-member is the same pre-claim by another
    // door: it must not grant membership on a note it never owned.
    const links = await executor.query(`
      DELETE FROM note_invite_links l
       WHERE l.note_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM workspace_members m
            WHERE m.workspace_id = $2 AND m.account_id = l.created_by
         )
      RETURNING l.id
    `, [noteId, workspaceId]);

    if (invitations.rowCount || keys.rowCount || links.rowCount) {
      purged.push({
        noteId,
        invitations: invitations.rowCount,
        keys: keys.rowCount,
        links: links.rowCount,
      });
    }
  }
  return purged;
}

module.exports = { reconcileNoteOwnership };
