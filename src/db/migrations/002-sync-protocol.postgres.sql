-- Postgres version of 002-sync-protocol.sql
-- Removes SQLite-specific rowid reference, uses ON CONFLICT DO NOTHING

CREATE TABLE IF NOT EXISTS sync_workspace_state (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('empty', 'initializing', 'initialized', 'recovering')),
  generation INTEGER NOT NULL DEFAULT 0,
  initialization_token TEXT,
  initialization_expires_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_document_state (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  note_id TEXT NOT NULL,
  snapshot_generation INTEGER NOT NULL DEFAULT 0,
  snapshot_key TEXT,
  checkpoint_ts INTEGER NOT NULL DEFAULT 0,
  checkpoint_sequence INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, note_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_yjs_update_identity
  ON yjs_doc_updates(workspace_id, note_id, device_id, clock);
CREATE INDEX IF NOT EXISTS idx_yjs_updates_pull
  ON yjs_doc_updates(workspace_id, note_id, ts, clock);

INSERT INTO sync_workspace_state (workspace_id, status, updated_at)
SELECT w.id,
       CASE WHEN EXISTS (
         SELECT 1 FROM yjs_doc_updates u WHERE u.workspace_id = w.id
       ) THEN 'initialized' ELSE 'empty' END,
       CURRENT_TIMESTAMP
FROM workspaces w
ON CONFLICT (workspace_id) DO NOTHING;

INSERT INTO sync_document_state (workspace_id, note_id, checkpoint_ts, checkpoint_sequence, updated_at)
SELECT workspace_id, note_id, ts, clock, CURRENT_TIMESTAMP
FROM (
  SELECT workspace_id, note_id, ts, clock,
         ROW_NUMBER() OVER (
           PARTITION BY workspace_id, note_id
           ORDER BY ts DESC, clock DESC, device_id DESC
         ) AS row_number
  FROM yjs_doc_updates
)
WHERE row_number = 1
ON CONFLICT (workspace_id, note_id) DO NOTHING;
