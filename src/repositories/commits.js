'use strict';

const { query } = require('../db');

// Client clocks drift. A commit stamped slightly ahead of the server must stay
// visible to its own author, so the future bound is a tolerance, not `now`.
const FUTURE_TS_TOLERANCE_MS = 5 * 60 * 1000;

// A note is "owned" by the workspace(s) holding its journal/snapshot rows,
// mirroring the collaboration bootstrap check. Any role counts: a viewer can
// read the note's content, so it can read its version history too.
async function userIsMemberOfNoteWorkspace(userId, noteId) {
  const { rows } = await query(`
    SELECT 1 FROM yjs_doc_updates u
      JOIN workspace_members m ON m.workspace_id = u.workspace_id
    WHERE u.note_id = $1 AND m.account_id = $2
    UNION ALL
    SELECT 1 FROM sync_document_state s
      JOIN workspace_members m ON m.workspace_id = s.workspace_id
     WHERE s.note_id = $1 AND m.account_id = $2
     UNION ALL
     SELECT 1 FROM note_invitations i
     WHERE i.note_id = $1 AND i.user_id = $2
     LIMIT 1
  `, [noteId, userId]);
  return rows.length > 0;
}

// `allAccounts` returns every account's commits for the note hash (the caller
// is a member of the workspace that owns the note). Otherwise only the caller's
// own commits, which covers personal notes and a pusher who is not a workspace
// member.
async function listHistory({ userId, noteIdHash, before, cutoffTs, limit, allAccounts = false }) {
  const params = [noteIdHash];
  let sql = `
    SELECT
      commits.commit_id AS commitId,
      commits.device_id AS deviceId,
      commits.clock,
      commits.ts,
      commits.created_at AS createdAt,
      accounts.username AS authorName,
      devices.label AS deviceLabel
    FROM commits
    LEFT JOIN accounts ON commits.account_id = accounts.id
    LEFT JOIN devices ON commits.account_id = devices.account_id AND commits.device_id = devices.device_id
    WHERE commits.note_id_hash = $1
  `;
  if (!allAccounts) {
    params.push(userId);
    sql += ` AND commits.account_id = $${params.length}`;
  }
  if (before) {
    params.push(before.toISOString());
    sql += ` AND commits.created_at < $${params.length}`;
  }
  const nowMs = Date.now();
  if (cutoffTs > 0) {
    params.push(cutoffTs);
    sql += ` AND commits.ts >= $${params.length}`;
  }
  // `ts` is client-supplied, so a wildly future-dated commit would otherwise
  // park itself outside the window forever. Allow real clock skew: a device
  // a few seconds ahead must still see its own history.
  params.push(nowMs + FUTURE_TS_TOLERANCE_MS);
  sql += ` AND commits.ts <= $${params.length}`;
  params.push(limit);
  sql += ` ORDER BY commits.created_at DESC LIMIT $${params.length}`;

  const { rows } = await query(sql, params);
  return rows;
}

module.exports = { listHistory, userIsMemberOfNoteWorkspace };
