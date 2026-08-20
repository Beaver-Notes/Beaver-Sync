-- Task 1: store per-device ML-KEM public keys as an append-only JSONB array
-- on each account, so multiple devices of one account are independently
-- addressable without clobbering each other's identity on sign-in.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS device_keys JSONB NOT NULL DEFAULT '[]'::jsonb;
