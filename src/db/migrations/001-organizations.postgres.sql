-- 001-organizations.sql
-- Add organizations, org_members, org_subscriptions tables
-- and extend workspaces with org_id, emoji, color

-- 1. Create organizations table
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name_encrypted TEXT NOT NULL,
  slug TEXT UNIQUE,
  created_at TEXT NOT NULL
);

-- 2. Create org_members table
CREATE TABLE IF NOT EXISTS org_members (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('owner', 'admin', 'member')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, account_id)
);

-- 3. Create org_subscriptions table
CREATE TABLE IF NOT EXISTS org_subscriptions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  plan TEXT NOT NULL CHECK(plan IN ('free', 'basic', 'pro', 'team', 'enterprise')),
  status TEXT DEFAULT 'active' CHECK(status IN ('active', 'grace_period', 'expired')),
  seats INTEGER DEFAULT 1,
  provider TEXT CHECK(provider IN ('stripe', 'apple', 'google')),
  renews_at TEXT,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  storage_quota_bytes INTEGER DEFAULT 0,
  storage_used_bytes INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);

-- 4. Add org_id to workspaces
ALTER TABLE workspaces ADD COLUMN org_id TEXT REFERENCES organizations(id);

-- 5. Add emoji and color to workspaces
ALTER TABLE workspaces ADD COLUMN emoji TEXT;
ALTER TABLE workspaces ADD COLUMN color TEXT;

-- 6. Create index for org membership lookups
CREATE INDEX IF NOT EXISTS idx_org_members_account ON org_members(account_id);
