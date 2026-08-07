-- Bind sessions created by sync clients to their device identity.
ALTER TABLE sessions ADD COLUMN device_id TEXT;
