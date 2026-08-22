CREATE TABLE IF NOT EXISTS yjs_documents (
  doc_name TEXT PRIMARY KEY,
  state_vector BYTEA,
  blob BYTEA NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_yjs_documents_updated ON yjs_documents(updated_at);
