'use strict';

const { query } = require('../db');

async function listHistory({ userId, noteIdHash, before, cutoffTs, limit }) {
  const params = [userId, noteIdHash];
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
    WHERE commits.account_id = $1 AND commits.note_id_hash = $2
  `;
  let paramIndex = 3;
  if (before) {
    sql += ` AND commits.created_at < $${paramIndex++}`;
    params.push(before.toISOString());
  }
  if (cutoffTs > 0) {
    sql += ` AND commits.created_at >= $${paramIndex++}`;
    params.push(new Date(cutoffTs).toISOString());
  }
  sql += ` ORDER BY commits.created_at DESC LIMIT $${paramIndex}`;
  params.push(limit);

  const { rows } = await query(sql, params);
  return rows;
}

module.exports = { listHistory };
