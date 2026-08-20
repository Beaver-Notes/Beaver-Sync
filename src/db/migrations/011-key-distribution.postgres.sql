-- Task 3: a server-side queue so a newly-linked device can ask an existing
-- online device of the same account to re-wrap the note's content key for its
-- new device id. Each pending request is a (note, account, target device)
-- tuple; an online device polls GET and clears a request once it has fanned
-- out the wrapped key.
CREATE TABLE IF NOT EXISTS key_distribution_requests (
  note_id          TEXT NOT NULL,
  user_id          TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  target_device_id TEXT NOT NULL,
  requested_at     TEXT NOT NULL,
  PRIMARY KEY (note_id, user_id, target_device_id)
);

CREATE INDEX IF NOT EXISTS idx_key_distribution_requests_user ON key_distribution_requests(user_id);
