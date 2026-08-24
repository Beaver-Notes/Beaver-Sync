'use strict';

const { query } = require('../db');

async function createEmptyState(workspaceId) {
  await query(
    'INSERT INTO sync_workspace_state (workspace_id, status, generation, updated_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
    [workspaceId, 'empty', 0, new Date().toISOString()]
  );
}

module.exports = { createEmptyState };
