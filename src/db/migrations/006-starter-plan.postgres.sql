-- 006-starter-plan.sql
-- Replace the retired 'basic' tier with 'starter' across both plan tables.
--
-- Postgres auto-names the inline CHECK constraints from schema.postgres.sql as
-- subscriptions_plan_check and org_subscriptions_plan_check. DROP + explicit
-- ADD keeps fresh installs (constraint created by CREATE TABLE) and existing
-- databases converging on the same five-tier matrix.
--
-- Rows are migrated first because both 'basic' and 'starter' satisfy the old
-- constraint; the new constraint is installed afterwards.

UPDATE subscriptions SET plan = 'starter' WHERE plan = 'basic';
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_plan_check;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_plan_check
  CHECK (plan IN ('free', 'starter', 'pro', 'team', 'enterprise'));

UPDATE org_subscriptions SET plan = 'starter' WHERE plan = 'basic';
ALTER TABLE org_subscriptions DROP CONSTRAINT IF EXISTS org_subscriptions_plan_check;
ALTER TABLE org_subscriptions ADD CONSTRAINT org_subscriptions_plan_check
  CHECK (plan IN ('free', 'starter', 'pro', 'team', 'enterprise'));
