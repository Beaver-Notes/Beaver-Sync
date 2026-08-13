-- 006-starter-plan.sql
-- Replace the retired 'basic' tier with 'starter' across both plan tables.
--
-- Postgres auto-names the inline CHECK constraints from schema.postgres.sql as
-- subscriptions_plan_check and org_subscriptions_plan_check. The OLD constraint
-- does NOT include 'starter', so the rows must be migrated only AFTER the
-- constraint is dropped: a bare UPDATE of 'basic' → 'starter' would violate the
-- still-active CHECK and abort the migration. This DROP → UPDATE → ADD order
-- mirrors 007-workspace-member-roles.postgres.sql.

ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_plan_check;
UPDATE subscriptions SET plan = 'starter' WHERE plan = 'basic';
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_plan_check
  CHECK (plan IN ('free', 'starter', 'pro', 'team', 'enterprise'));

ALTER TABLE org_subscriptions DROP CONSTRAINT IF EXISTS org_subscriptions_plan_check;
UPDATE org_subscriptions SET plan = 'starter' WHERE plan = 'basic';
ALTER TABLE org_subscriptions ADD CONSTRAINT org_subscriptions_plan_check
  CHECK (plan IN ('free', 'starter', 'pro', 'team', 'enterprise'));
