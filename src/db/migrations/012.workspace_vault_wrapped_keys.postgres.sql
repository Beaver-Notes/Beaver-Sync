-- Task 3: store the creator-side envelope that wraps the raw workspace key
-- under the account's session encryption key (AEK), bound to the
-- 'beaver-workspace-keys:v1' AAD domain. Any member who recovers their AEK by
-- re-entering the vault passphrase can unwrap the workspace key locally,
-- instead of needing an ML-KEM re-wrap from the original device.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS vault_wrapped_keys TEXT;
