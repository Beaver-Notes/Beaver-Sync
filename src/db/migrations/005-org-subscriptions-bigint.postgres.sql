-- org_subscriptions byte columns must hold enterprise quotas (up to
-- Number.MAX_SAFE_INTEGER) and match the BIGINT storage columns on
-- subscriptions. INTEGER overflows those values on Postgres.
ALTER TABLE org_subscriptions ALTER COLUMN storage_quota_bytes TYPE BIGINT;
ALTER TABLE org_subscriptions ALTER COLUMN storage_used_bytes TYPE BIGINT;
