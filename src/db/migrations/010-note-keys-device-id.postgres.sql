-- Task 2: store note content key envelopes per-device so a note key can be
-- fanned out to every device of every collaborator. The previous PK was
-- (note_id, user_id); we add `device_id` and widen the PK so two devices of
-- the same account each carry their own wrapped key.
ALTER TABLE note_keys ADD COLUMN IF NOT EXISTS device_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE note_keys DROP CONSTRAINT IF EXISTS note_keys_pkey;
ALTER TABLE note_keys ADD PRIMARY KEY (note_id, user_id, device_id);
