-- Add snapshot_ts column to sync_document_state for AAD binding during snapshot bootstrap
ALTER TABLE sync_document_state ADD COLUMN IF NOT EXISTS snapshot_ts BIGINT NOT NULL DEFAULT 0;
