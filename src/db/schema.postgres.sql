-- Postgres schema for Beaver Sync

CREATE TABLE IF NOT EXISTS accounts (
  id                    TEXT PRIMARY KEY,
  username              TEXT,
  email_hmac            TEXT NOT NULL UNIQUE,
  email_encrypted       TEXT,
  kem_public_key        TEXT,
  device_keys           JSONB NOT NULL DEFAULT '[]'::jsonb,
  password_hash         TEXT,
  recovery_key_hash     TEXT,
  failed_login_attempts BIGINT NOT NULL DEFAULT 0,
  locked_until          TEXT,
  kdf_salt              TEXT,
  wrapped_aek           TEXT,
  recovery_code_hash    TEXT,
  recovery_code_generated_at TIMESTAMPTZ,
  created_at            TEXT NOT NULL
);

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS jwt_revoked_at TIMESTAMPTZ;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS verification_token_hash TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS verification_expires_at TIMESTAMPTZ;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS password_reset_token_hash TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS password_reset_expires_at TIMESTAMPTZ;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS totp_secret_encrypted TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS totp_pending_secret_encrypted TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS totp_pending_expires_at TIMESTAMPTZ;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS totp_last_timestep BIGINT;

CREATE TABLE IF NOT EXISTS ws_tickets (
  id_hash    TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  device_id  TEXT,
  role       TEXT,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS mfa_challenges (
  id_hash    TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name_encrypted TEXT NOT NULL,
  slug TEXT UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id                 TEXT PRIMARY KEY,
  name_encrypted     TEXT NOT NULL,
  owner_id           TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  org_id             TEXT REFERENCES organizations(id),
  vault_wrapped_keys TEXT,
  storage_used_bytes BIGINT NOT NULL DEFAULT 0 CHECK(storage_used_bytes >= 0),
  data_residency     TEXT NOT NULL DEFAULT 'auto' CHECK(data_residency IN ('auto', 'eu', 'us', 'asia', 'custom')),
  emoji              TEXT,
  color              TEXT,
  created_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash                 TEXT PRIMARY KEY,
  account_id              TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  workspace_id            TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  device_label            TEXT NOT NULL DEFAULT 'Unknown Device',
  device_id               TEXT,
  device_fingerprint_hash TEXT,
  ip_subnet               TEXT,
  expires_at              TEXT NOT NULL,
  last_seen_at            TEXT NOT NULL,
  revoked                 INTEGER NOT NULL DEFAULT 0,
  created_at              TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS commits (
  commit_id          TEXT PRIMARY KEY,
  account_id         TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  device_id          TEXT NOT NULL,
  note_id_hash       TEXT,
  workspace_id       TEXT,
  payload_encrypted  TEXT,
  clock              BIGINT NOT NULL,
  ts                 BIGINT NOT NULL,
  size_bytes         BIGINT NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                 TEXT PRIMARY KEY,
  account_id         TEXT NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  plan               TEXT NOT NULL CHECK(plan IN ('free', 'starter', 'pro', 'team', 'enterprise')),
  status             TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'grace_period', 'expired')),
  provider           TEXT CHECK(provider IN ('stripe', 'apple', 'google')),
  renews_at          TEXT,

  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  apple_original_transaction_id TEXT,
  google_purchase_token TEXT,
  storage_quota_bytes  BIGINT NOT NULL DEFAULT 0,
  storage_used_bytes   BIGINT NOT NULL DEFAULT 0 CHECK(storage_used_bytes >= 0),
  created_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  device_id  TEXT NOT NULL,
  label      TEXT NOT NULL DEFAULT 'Unknown Device',
  last_seen  TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(account_id, device_id)
);

CREATE TABLE IF NOT EXISTS credentials (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key    TEXT NOT NULL,
  sign_count    BIGINT NOT NULL DEFAULT 0,
  device_label  TEXT NOT NULL DEFAULT 'Unknown Device',
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quick_connect_codes (
  code       TEXT PRIMARY KEY,
  secret     TEXT NOT NULL UNIQUE,
  authorized INTEGER NOT NULL DEFAULT 0,
  payload    TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS compaction_locks (
  id         TEXT PRIMARY KEY,
  locked_at  TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS note_keys (
  note_id     TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  device_id   TEXT NOT NULL DEFAULT 'default',
  wrapped_key TEXT NOT NULL,
  generation  BIGINT NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (note_id, user_id, device_id)
);

CREATE TABLE IF NOT EXISTS workspace_keys (
  workspace_id TEXT NOT NULL,
  user_id      TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  device_id    TEXT,
  wrapped_key  TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS org_keys (
  org_id      TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  wrapped_key TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_note_keys_user ON note_keys(user_id);

CREATE TABLE IF NOT EXISTS key_distribution_requests (
  note_id          TEXT NOT NULL,
  user_id          TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  target_device_id TEXT NOT NULL,
  requested_at     TEXT NOT NULL,
  PRIMARY KEY (note_id, user_id, target_device_id)
);

CREATE INDEX IF NOT EXISTS idx_key_distribution_requests_user ON key_distribution_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_workspace_keys_user ON workspace_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_org_keys_user ON org_keys(user_id);

CREATE TABLE IF NOT EXISTS org_members (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('owner', 'admin', 'member')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, account_id)
);

CREATE INDEX IF NOT EXISTS idx_org_members_account ON org_members(account_id);

CREATE TABLE IF NOT EXISTS org_subscriptions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  plan TEXT NOT NULL CHECK(plan IN ('free', 'starter', 'pro', 'team', 'enterprise')),
  status TEXT DEFAULT 'active' CHECK(status IN ('active', 'grace_period', 'expired')),
  seats INTEGER DEFAULT 1,
  provider TEXT CHECK(provider IN ('stripe', 'apple', 'google')),
  renews_at TEXT,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  storage_quota_bytes BIGINT DEFAULT 0,
  storage_used_bytes BIGINT DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS org_invites (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by       TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash       TEXT NOT NULL UNIQUE,
  role             TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('member', 'admin')),
  require_approval INTEGER NOT NULL DEFAULT 0,
  approved_by      TEXT,
  max_uses         INTEGER NOT NULL DEFAULT 0,
  used_count       INTEGER NOT NULL DEFAULT 0,
  expires_at       TEXT,
  revoked          INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_org_invites_org ON org_invites(org_id);

-- Approval is per requesting account, never per invite: approving one joiner
-- must not turn a require-approval link into an unlimited self-join.
CREATE TABLE IF NOT EXISTS org_join_requests (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  invite_id   TEXT NOT NULL REFERENCES org_invites(id) ON DELETE CASCADE,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved')),
  approved_by TEXT,
  approved_at TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE (invite_id, account_id)
);
CREATE INDEX IF NOT EXISTS idx_org_join_requests_invite ON org_join_requests(invite_id, status);

CREATE TABLE IF NOT EXISTS note_invitations (
  note_id      TEXT NOT NULL,
  user_id      TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  invited_by   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role         TEXT NOT NULL DEFAULT 'editor' CHECK(role IN ('editor', 'viewer')),
  created_at   TEXT NOT NULL,
  PRIMARY KEY (note_id, user_id)
);

CREATE TABLE IF NOT EXISTS note_invite_links (
  id               TEXT PRIMARY KEY,
  note_id          TEXT NOT NULL,
  created_by       TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash       TEXT NOT NULL UNIQUE,
  role             TEXT NOT NULL CHECK(role IN ('editor', 'viewer')),
  require_approval INTEGER NOT NULL DEFAULT 0,
  expires_at       TEXT,
  revoked          INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_note_invite_links_note ON note_invite_links(note_id);
CREATE INDEX IF NOT EXISTS idx_note_invite_links_token ON note_invite_links(token_hash);

-- Approval is per requesting account, never per invite: approving one joiner
-- must not turn a require-approval link into an unlimited self-join. A row's
-- existence means "pending"; approval grants the link role and deletes it.
CREATE TABLE IF NOT EXISTS note_join_requests (
  id          TEXT PRIMARY KEY,
  note_id     TEXT NOT NULL,
  invite_id   TEXT NOT NULL REFERENCES note_invite_links(id) ON DELETE CASCADE,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  UNIQUE (invite_id, account_id)
);
CREATE INDEX IF NOT EXISTS idx_note_join_requests_note ON note_join_requests(note_id);

CREATE TABLE IF NOT EXISTS email_aliases (
  alias            TEXT PRIMARY KEY,
  account_id       TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email_encrypted  TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  expires_at       TEXT
);

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id         TEXT PRIMARY KEY,
  email_hmac TEXT NOT NULL,
  challenge  TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK(role IN ('owner', 'admin', 'editor', 'viewer')),
  created_at   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, account_id)
);

CREATE TABLE IF NOT EXISTS workspace_invites (
  token_hash       TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role             TEXT NOT NULL CHECK(role IN ('editor', 'viewer')),
  require_approval INTEGER NOT NULL DEFAULT 0,
  expires_at       TEXT NOT NULL,
  max_uses         INTEGER NOT NULL DEFAULT 0,
  used_count       INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL
);

-- Per-requester approval for require-approval workspace invites; mirrors
-- note_join_requests. Existence means pending; approval grants and deletes.
CREATE TABLE IF NOT EXISTS workspace_join_requests (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  invite_id     TEXT NOT NULL REFERENCES workspace_invites(token_hash) ON DELETE CASCADE,
  account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL,
  UNIQUE (invite_id, account_id)
);
CREATE INDEX IF NOT EXISTS idx_workspace_join_requests_workspace ON workspace_join_requests(workspace_id);

CREATE TABLE IF NOT EXISTS sso_configs (
  id                      TEXT PRIMARY KEY,
  workspace_id            TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  protocol                TEXT NOT NULL CHECK(protocol IN ('saml', 'oidc')),
  slug                    TEXT NOT NULL UNIQUE,
  idp_entity_id           TEXT,
  idp_sso_url             TEXT,
  idp_cert_encrypted      TEXT,
  oidc_issuer             TEXT,
  oidc_client_id          TEXT,
  oidc_client_secret_encrypted TEXT,
  sp_cert                 TEXT,
  sp_private_key_encrypted TEXT,
  allowed_email_domains   TEXT,
  created_at              TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sso_oidc_states (
  state          TEXT PRIMARY KEY,
  code_verifier  TEXT NOT NULL,
  nonce          TEXT,
  slug           TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id                TEXT PRIMARY KEY,
  account_id_hash   TEXT NOT NULL,
  workspace_id      TEXT,
  action            TEXT NOT NULL,
  metadata_encrypted TEXT,
  ip_subnet         TEXT,
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_account_id ON sessions(account_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_commits_account_device_clock ON commits(account_id, device_id, clock);
CREATE INDEX IF NOT EXISTS idx_commits_account_created ON commits(account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_subscriptions_account_id ON subscriptions(account_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_customer ON subscriptions(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_sub ON subscriptions(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_apple ON subscriptions(apple_original_transaction_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_google ON subscriptions(google_purchase_token);
CREATE INDEX IF NOT EXISTS idx_devices_account_device ON devices(account_id, device_id);
CREATE INDEX IF NOT EXISTS idx_credentials_account_id ON credentials(account_id);
CREATE INDEX IF NOT EXISTS idx_quick_connect_codes_expires ON quick_connect_codes(expires_at);
CREATE INDEX IF NOT EXISTS idx_compaction_locks_expires ON compaction_locks(expires_at);
CREATE INDEX IF NOT EXISTS idx_sso_configs_slug ON sso_configs(slug);
CREATE INDEX IF NOT EXISTS idx_sso_configs_workspace ON sso_configs(workspace_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_workspace ON audit_logs(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_account ON audit_logs(account_id_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_email_aliases_account ON email_aliases(account_id);
CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_email ON webauthn_challenges(email_hmac);
CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_expires ON webauthn_challenges(expires_at);

CREATE TABLE IF NOT EXISTS yjs_doc_updates (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  note_id         TEXT NOT NULL,
  update_data     BYTEA NOT NULL,
  update_encrypted INTEGER NOT NULL DEFAULT 0,
  device_id       TEXT NOT NULL,
  clock           BIGINT NOT NULL,
  ts              BIGINT NOT NULL,
  created_at      TEXT NOT NULL,
  UNIQUE (workspace_id, note_id, device_id, clock)
);

CREATE INDEX IF NOT EXISTS idx_yjs_doc_updates_workspace_note ON yjs_doc_updates(workspace_id, note_id, ts);
CREATE INDEX IF NOT EXISTS idx_yjs_doc_updates_device ON yjs_doc_updates(workspace_id, note_id, device_id);

CREATE TABLE IF NOT EXISTS sync_workspace_state (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('empty', 'initializing', 'initialized', 'recovering')),
  generation BIGINT NOT NULL DEFAULT 0,
  initialization_token TEXT,
  initialization_expires_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_document_state (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  note_id TEXT NOT NULL,
  snapshot_generation BIGINT NOT NULL DEFAULT 0,
  snapshot_key TEXT,
  snapshot_ts BIGINT NOT NULL DEFAULT 0,
  checkpoint_ts BIGINT NOT NULL DEFAULT 0,
  checkpoint_sequence BIGINT NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, note_id)
);

CREATE INDEX IF NOT EXISTS idx_yjs_updates_pull
  ON yjs_doc_updates(workspace_id, note_id, ts, clock);

CREATE TABLE IF NOT EXISTS vault_key_params (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_id           TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Despite the legacy column name, this stores only bcrypt(clientProof), never plaintext.
  passphrase_hash    TEXT NOT NULL,
  proof_version      INTEGER NOT NULL DEFAULT 0,
  key_params_blob    TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vault_key_params_workspace ON vault_key_params(workspace_id);

-- Phase 2: one vault key per account. The account row is adopted
-- deterministically from the oldest per-workspace row the account published and
-- is never rewritten. The per-workspace `vault_key_params` rows above stay
-- readable for migration and are never deleted by adoption.
CREATE TABLE IF NOT EXISTS account_vault_key_params (
  id                 TEXT PRIMARY KEY,
  account_id         TEXT NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  owner_id           TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  key_params_blob    TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS note_comments (
  id                TEXT PRIMARY KEY,
  note_id           TEXT NOT NULL,
  thread_id         TEXT NOT NULL,
  author_id         TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  content_encrypted TEXT NOT NULL,
  content_iv        TEXT NOT NULL,
  anchor_from       BIGINT,
  anchor_to         BIGINT,
  resolved          INTEGER NOT NULL DEFAULT 0,
  parent_id         TEXT,
  mentions          TEXT NOT NULL DEFAULT '[]',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_note_comments_note ON note_comments(note_id);
CREATE INDEX IF NOT EXISTS idx_note_comments_thread ON note_comments(thread_id);

-- Opaque edit/activity entries for shared notes (Phase 2). Content is encrypted
-- client-side with the shared note key; the server stores no plaintext.
CREATE TABLE IF NOT EXISTS note_activity (
  id                TEXT PRIMARY KEY,
  note_id           TEXT NOT NULL,
  author_id         TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind              TEXT,
  content_encrypted TEXT NOT NULL,
  content_iv        TEXT NOT NULL,
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_note_activity_note ON note_activity(note_id, created_at);

CREATE TABLE IF NOT EXISTS vault_proof_challenges (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  challenge_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vault_proof_challenges_lookup
  ON vault_proof_challenges(workspace_id, account_id, expires_at);

CREATE TABLE IF NOT EXISTS yjs_documents (
  doc_name TEXT PRIMARY KEY,
  state_vector BYTEA,
  blob BYTEA NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_yjs_documents_updated ON yjs_documents(updated_at);

CREATE TABLE IF NOT EXISTS asset_reservations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  asset_key TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK(size_bytes >= 0),
  status TEXT NOT NULL CHECK(status IN ('pending', 'confirmed')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_asset_reservations_account ON asset_reservations(account_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_asset_reservations_expires ON asset_reservations(expires_at) WHERE status = 'pending';
