# Multi-Account + Organization + Yjs Unified Persistence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the account/workspace model with organizations as billing entities, add multi-account support, unify Yjs persistence, and wire up missing features.

**Architecture:** Organizations are the billing entity. Every user gets a personal org with a default workspace. Companies get seat-based orgs with multiple workspaces. SQLite becomes the single source of truth for Yjs updates, with R2 as backup.

**Tech Stack:** Fastify (backend), SQLite (database), Yjs + Hocuspocus (collaboration), Vue 3 + Pinia (frontend), Tauri (desktop)

## Global Constraints

- Backend: Node.js 24, Fastify, SQLite via `better-sqlite3`
- Frontend: Vue 3, Pinia, Tailwind CSS, Tauri 2
- Database: SQLite (no migrations framework, manual SQL)
- Breaking change: API version bump required
- Existing data must migrate without data loss

---

## Phase 1: Backend — Database & Org Model

### Task 1: Database Migration Script

**Files:**
- Create: `Beaver-Sync/src/db/migrations/001-organizations.sql`
- Modify: `Beaver-Sync/src/db/index.js` (add migration runner)

**Interfaces:**
- Consumes: existing SQLite database
- Produces: new tables `organizations`, `org_members`, `org_subscriptions`; modified `workspaces` table

- [ ] **Step 1: Create migration SQL file**

```sql
-- Beaver-Sync/src/db/migrations/001-organizations.sql

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
```

- [ ] **Step 2: Add migration runner to db/index.js**

```js
// Add to src/db/index.js after existing schema setup

const fs = require('fs');
const path = require('path');

function runMigrations() {
  const db = getDb();
  const migrationsDir = path.join(__dirname, 'migrations');
  
  if (!fs.existsSync(migrationsDir)) return;
  
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  
  for (const file of files) {
    const migrationPath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(migrationPath, 'utf8');
    
    db.exec(sql);
    console.log(`[db] Applied migration: ${file}`);
  }
}

// Call after schema setup
runMigrations();
```

- [ ] **Step 3: Run migration to verify it works**

Run: `cd Beaver-Sync && node -e "require('./src/db')"`
Expected: Migration applied successfully, new tables created

- [ ] **Step 4: Commit**

```bash
git add src/db/migrations/001-organizations.sql src/db/index.js
git commit -m "feat(db): add organizations tables and migration"
```

---

### Task 2: Data Migration Script

**Files:**
- Create: `Beaver-Sync/src/db/migrate-data.js`

**Interfaces:**
- Consumes: existing `accounts`, `workspaces`, `subscriptions` tables
- Produces: populated `organizations`, `org_members`, `org_subscriptions` tables; `workspaces.org_id` set

- [ ] **Step 1: Create data migration script**

```js
// Beaver-Sync/src/db/migrate-data.js

const crypto = require('crypto');
const { getDb } = require('./index');

function migrateData() {
  const db = getDb();
  
  const accounts = db.prepare('SELECT id, username, email_hmac FROM accounts').all();
  
  for (const account of accounts) {
    // Check if personal org already exists
    const existingOrg = db.prepare(`
      SELECT o.id FROM organizations o
      JOIN org_members om ON o.id = om.org_id
      WHERE om.account_id = ? AND om.role = 'owner'
      LIMIT 1
    `).get(account.id);
    
    if (existingOrg) continue;
    
    // Create personal org
    const orgId = crypto.randomUUID();
    const orgName = account.username || account.email_hmac.slice(0, 8);
    const slug = orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    
    db.prepare(`
      INSERT INTO organizations (id, name_encrypted, slug, created_at)
      VALUES (?, ?, ?, ?)
    `).run(orgId, orgName, slug, new Date().toISOString());
    
    // Add account as org owner
    db.prepare(`
      INSERT INTO org_members (org_id, account_id, role, created_at)
      VALUES (?, ?, 'owner', ?)
    `).run(orgId, account.id, new Date().toISOString());
    
    // Create free-tier subscription
    db.prepare(`
      INSERT INTO org_subscriptions (id, org_id, plan, status, seats, created_at)
      VALUES (?, ?, 'free', 'active', 1, ?)
    `).run(crypto.randomUUID(), orgId, new Date().toISOString());
    
    // Migrate existing workspaces
    const workspaces = db.prepare('SELECT id FROM workspaces WHERE owner_id = ?').all(account.id);
    for (const ws of workspaces) {
      db.prepare('UPDATE workspaces SET org_id = ? WHERE id = ?').run(orgId, ws.id);
    }
    
    // Migrate existing subscription
    const sub = db.prepare('SELECT * FROM subscriptions WHERE account_id = ?').get(account.id);
    if (sub) {
      db.prepare(`
        UPDATE org_subscriptions SET plan = ?, status = ?, storage_quota_bytes = ?
        WHERE org_id = ?
      `).run(sub.plan, sub.status, sub.storage_quota_bytes, orgId);
    }
    
    console.log(`[migrate] Migrated account ${account.id} → org ${orgId}`);
  }
}

if (require.main === module) {
  migrateData();
}

module.exports = { migrateData };
```

- [ ] **Step 2: Run data migration**

Run: `cd Beaver-Sync && node src/db/migrate-data.js`
Expected: All existing accounts get personal orgs, workspaces get org_id

- [ ] **Step 3: Verify migration**

Run: `cd Beaver-Sync && node -e "const db = require('./src/db').getDb(); console.log('Orgs:', db.prepare('SELECT COUNT(*) as c FROM organizations').get().c); console.log('Org members:', db.prepare('SELECT COUNT(*) as c FROM org_members').get().c); console.log('Workspaces with org_id:', db.prepare('SELECT COUNT(*) as c FROM workspaces WHERE org_id IS NOT NULL').get().c)"`
Expected: Counts match existing data

- [ ] **Step 4: Commit**

```bash
git add src/db/migrate-data.js
git commit -m "feat(db): add data migration for organizations"
```

---

### Task 3: Organization Model

**Files:**
- Modify: `Beaver-Sync/src/models/index.js` (add to ALLOWED_TABLES)

**Interfaces:**
- Consumes: database tables
- Produces: `Organization`, `OrgMember`, `OrgSubscription` models

- [ ] **Step 1: Add new tables to ALLOWED_TABLES**

```js
// In src/models/index.js, add to ALLOWED_TABLES Set
const ALLOWED_TABLES = new Set([
  'accounts', 'sessions', 'commits', 'workspaces', 'subscriptions',
  'devices', 'credentials', 'quick_connect_codes', 'compaction_locks',
  'collaboration_keys', 'note_invitations', 'email_aliases',
  'webauthn_challenges', 'workspace_members', 'workspace_invites',
  'sso_configs', 'sso_oidc_states', 'audit_logs', 'yjs_doc_updates',
  'vault_key_params', 'note_invite_links',
  // New org tables
  'organizations', 'org_members', 'org_subscriptions',
]);
```

- [ ] **Step 2: Add model exports**

```js
// At bottom of src/models/index.js, add exports
const Organization = createModel('organizations');
const OrgMember = createModel('org_members', '_composite');
const OrgSubscription = createModel('org_subscriptions');

module.exports = {
  Account, Session, CommitMeta, Device, Subscription,
  Credential, QuickConnectCode, CompactionLock,
  CollaborationKey, NoteInvitation,
  Workspace, WorkspaceMember, WorkspaceInvite,
  AuditLog, SsoConfig, SsoOidcState, EmailAlias, WebAuthnChallenge,
  YjsDocUpdate, VaultKeyParams, NoteInviteLink,
  // New exports
  Organization, OrgMember, OrgSubscription,
};
```

- [ ] **Step 3: Verify models work**

Run: `cd Beaver-Sync && node -e "const { Organization, OrgMember, OrgSubscription } = require('./src/models'); console.log('Models loaded:', !!Organization, !!OrgMember, !!OrgSubscription)"`
Expected: `Models loaded: true true true`

- [ ] **Step 4: Commit**

```bash
git add src/models/index.js
git commit -m "feat(models): add Organization, OrgMember, OrgSubscription models"
```

---

### Task 4: Org Middleware

**Files:**
- Create: `Beaver-Sync/src/middleware/org.js`

**Interfaces:**
- Consumes: `app.authenticate` (sets `req.userId`), `:id` param
- Produces: `req.orgId`, `req.orgRole`

- [ ] **Step 1: Create org middleware**

```js
// Beaver-Sync/src/middleware/org.js

'use strict';

const { OrgMember } = require('../models');

async function requireOrgMember(req, reply) {
  const orgId = req.params.id;
  
  if (!orgId) {
    return reply.status(400).send({ error: 'missing_org_id' });
  }
  
  const membership = await OrgMember.findOne({
    org_id: orgId,
    account_id: req.userId,
  }).lean();
  
  if (!membership) {
    return reply.status(403).send({ error: 'not_org_member' });
  }
  
  req.orgId = orgId;
  req.orgRole = membership.role;
}

async function requireOrgAdmin(req, reply) {
  await requireOrgMember(req, reply);
  if (reply.sent) return;
  
  if (!['owner', 'admin'].includes(req.orgRole)) {
    return reply.status(403).send({ error: 'org_admin_required' });
  }
}

async function requireOrgOwner(req, reply) {
  await requireOrgMember(req, reply);
  if (reply.sent) return;
  
  if (req.orgRole !== 'owner') {
    return reply.status(403).send({ error: 'org_owner_required' });
  }
}

module.exports = { requireOrgMember, requireOrgAdmin, requireOrgOwner };
```

- [ ] **Step 2: Commit**

```bash
git add src/middleware/org.js
git commit -m "feat(middleware): add org membership middleware"
```

---

## Phase 2: Backend — API Endpoints

### Task 5: Registration Flow Update

**Files:**
- Modify: `Beaver-Sync/src/routes/auth.js`

**Interfaces:**
- Consumes: `Organization`, `OrgMember`, `OrgSubscription`, `Workspace`, `WorkspaceMember` models
- Produces: updated registration response with org + workspace info

- [ ] **Step 1: Update registration endpoint**

```js
// In src/routes/auth.js, update the POST /register handler

const { Account, Subscription, Session, Workspace, WorkspaceMember, Organization, OrgMember, OrgSubscription } = require('../models');

// ... existing register code ...

// After account creation and subscription creation:
const plan = isEnterpriseMode() ? 'enterprise' : 'free';
const storageQuotaBytes = isEnterpriseMode() ? getQuotaBytes('enterprise') : 0;

// 1. Create personal org
const orgId = crypto.randomUUID();
const orgName = account.username || email.split('@')[0];
const slug = orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-');

await Organization.create({
  id: orgId,
  name_encrypted: orgName,
  slug,
  createdAt: new Date(),
});

await OrgMember.create({
  orgId: account.id,  // This is wrong, should be orgId
  accountId: account.id,
  role: 'owner',
  createdAt: new Date(),
});

await OrgSubscription.create({
  id: crypto.randomUUID(),
  orgId,
  plan,
  status: 'active',
  seats: 1,
  storageQuotaBytes,
  createdAt: new Date(),
});

// 2. Create default workspace in personal org
const defaultWorkspace = await Workspace.create({
  nameEncrypted: 'Default',
  orgId,
  createdAt: new Date(),
});

await WorkspaceMember.create({
  workspaceId: defaultWorkspace.id,
  accountId: account.id,
  role: 'owner',
  createdAt: new Date(),
});

// 3. Create session
const token = await createSession(account.id, req);

// 4. Return enhanced response
return reply.status(201).send({
  token,
  user: {
    id: account.id,
    emailHash: account.emailHmac,
    kdfSalt: account.kdfSalt,
  },
  organization: {
    id: orgId,
    name: orgName,
    role: 'owner',
  },
  workspace: {
    id: defaultWorkspace.id,
    name: 'Default',
    role: 'owner',
  },
});
```

- [ ] **Step 2: Test registration**

Run: `cd Beaver-Sync && curl -X POST http://localhost:3000/auth/register -H "Content-Type: application/json" -d '{"email":"test@example.com","password":"123456789012"}'`
Expected: 201 with token, user, organization, workspace

- [ ] **Step 3: Commit**

```bash
git add src/routes/auth.js
git commit -m "feat(auth): update registration to create personal org and default workspace"
```

---

### Task 6: Organization CRUD Endpoints

**Files:**
- Create: `Beaver-Sync/src/routes/organizations.js`

**Interfaces:**
- Consumes: `Organization`, `OrgMember`, `OrgSubscription` models, `requireOrgMember/Admin/Owner` middleware
- Produces: org CRUD API

- [ ] **Step 1: Create organizations route file**

```js
// Beaver-Sync/src/routes/organizations.js

'use strict';

const crypto = require('crypto');
const { Organization, OrgMember, OrgSubscription, Workspace, WorkspaceMember } = require('../models');
const { requireOrgMember, requireOrgAdmin, requireOrgOwner } = require('../middleware/org');

async function organizationRoutes(app) {
  await app.register(require('../middleware/auth'));

  const protect = {
    preHandler: [app.authenticate],
  };

  // List user's organizations
  app.get('/', protect, async (req, reply) => {
    const memberships = await OrgMember.find({ account_id: req.userId }).lean();
    const orgIds = memberships.map(m => m.org_id);
    
    const orgs = await Organization.find({ _id: { $in: orgIds } }).lean();
    
    const result = orgs.map(org => {
      const membership = memberships.find(m => m.org_id === org.id);
      return {
        id: org.id,
        name: org.name_encrypted,
        slug: org.slug,
        role: membership.role,
        createdAt: org.created_at,
      };
    });
    
    return reply.send(result);
  });

  // Create organization
  app.post('/', protect, async (req, reply) => {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return reply.status(400).send({ error: 'name_required' });
    }

    const orgId = crypto.randomUUID();
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

    await Organization.create({
      id: orgId,
      name_encrypted: name.trim(),
      slug,
      createdAt: new Date(),
    });

    await OrgMember.create({
      orgId,
      accountId: req.userId,
      role: 'owner',
      createdAt: new Date(),
    });

    await OrgSubscription.create({
      id: crypto.randomUUID(),
      orgId,
      plan: 'free',
      status: 'active',
      seats: 1,
      createdAt: new Date(),
    });

    // Create default workspace
    const workspace = await Workspace.create({
      nameEncrypted: 'Default',
      orgId,
      createdAt: new Date(),
    });

    await WorkspaceMember.create({
      workspaceId: workspace.id,
      accountId: req.userId,
      role: 'owner',
      createdAt: new Date(),
    });

    return reply.status(201).send({
      id: orgId,
      name: name.trim(),
      slug,
      role: 'owner',
      workspace: {
        id: workspace.id,
        name: 'Default',
      },
    });
  });

  // Get organization details
  app.get('/:id', protect, { preHandler: [requireOrgMember] }, async (req, reply) => {
    const org = await Organization.findById(req.orgId).lean();
    if (!org) {
      return reply.status(404).send({ error: 'not_found' });
    }

    const subscription = await OrgSubscription.findOne({ org_id: req.orgId }).lean();
    const workspaces = await Workspace.find({ org_id: req.orgId }).lean();

    return reply.send({
      id: org.id,
      name: org.name_encrypted,
      slug: org.slug,
      role: req.orgRole,
      subscription: subscription ? {
        plan: subscription.plan,
        status: subscription.status,
        seats: subscription.seats,
      } : null,
      workspaces: workspaces.map(ws => ({
        id: ws.id,
        name: ws.name_encrypted,
        emoji: ws.emoji,
        color: ws.color,
      })),
    });
  });

  // Update organization
  app.patch('/:id', protect, { preHandler: [requireOrgAdmin] }, async (req, reply) => {
    const { name } = req.body;
    if (name) {
      await Organization.updateOne(
        { _id: req.orgId },
        { $set: { name_encrypted: name.trim() } }
      );
    }
    return reply.send({ updated: true });
  });

  // Delete organization
  app.delete('/:id', protect, { preHandler: [requireOrgOwner] }, async (req, reply) => {
    // Check for remaining workspaces
    const workspaces = await Workspace.find({ org_id: req.orgId }).lean();
    if (workspaces.length > 0) {
      return reply.status(400).send({ 
        error: 'org_has_workspaces',
        message: 'Transfer or delete all workspaces before deleting the organization.' 
      });
    }

    await OrgMember.deleteMany({ org_id: req.orgId });
    await OrgSubscription.deleteOne({ org_id: req.orgId });
    await Organization.deleteOne({ _id: req.orgId });

    return reply.send({ deleted: true });
  });

  // List members
  app.get('/:id/members', protect, { preHandler: [requireOrgMember] }, async (req, reply) => {
    const members = await OrgMember.find({ org_id: req.orgId }).lean();
    return reply.send(members.map(m => ({
      accountId: m.account_id,
      role: m.role,
      createdAt: m.created_at,
    })));
  });

  // Add member
  app.post('/:id/members', protect, { preHandler: [requireOrgAdmin] }, async (req, reply) => {
    const { accountId, role = 'member' } = req.body;
    if (!accountId) {
      return reply.status(400).send({ error: 'account_id_required' });
    }

    const existing = await OrgMember.findOne({
      org_id: req.orgId,
      account_id: accountId,
    }).lean();

    if (existing) {
      return reply.status(409).send({ error: 'already_member' });
    }

    await OrgMember.create({
      orgId: req.orgId,
      accountId,
      role,
      createdAt: new Date(),
    });

    return reply.status(201).send({ added: true });
  });

  // Update member role
  app.patch('/:id/members/:uid', protect, { preHandler: [requireOrgOwner] }, async (req, reply) => {
    const { role } = req.body;
    if (!['admin', 'member'].includes(role)) {
      return reply.status(400).send({ error: 'invalid_role' });
    }

    await OrgMember.updateOne(
      { org_id: req.orgId, account_id: req.params.uid },
      { $set: { role } }
    );

    return reply.send({ updated: true });
  });

  // Remove member
  app.delete('/:id/members/:uid', protect, { preHandler: [requireOrgAdmin] }, async (req, reply) => {
    if (req.params.uid === req.userId) {
      return reply.status(400).send({ error: 'cannot_remove_self' });
    }

    await OrgMember.deleteOne({
      org_id: req.orgId,
      account_id: req.params.uid,
    });

    return reply.send({ removed: true });
  });

  // Leave organization
  app.post('/:id/leave', protect, { preHandler: [requireOrgMember] }, async (req, reply) => {
    if (req.orgRole === 'owner') {
      return reply.status(400).send({ error: 'owner_cannot_leave' });
    }

    await OrgMember.deleteOne({
      org_id: req.orgId,
      account_id: req.userId,
    });

    return reply.send({ left: true });
  });

  // Get subscription
  app.get('/:id/subscription', protect, { preHandler: [requireOrgAdmin] }, async (req, reply) => {
    const sub = await OrgSubscription.findOne({ org_id: req.orgId }).lean();
    if (!sub) {
      return reply.status(404).send({ error: 'not_found' });
    }
    return reply.send({
      plan: sub.plan,
      status: sub.status,
      seats: sub.seats,
      storageQuotaBytes: sub.storage_quota_bytes,
      storageUsedBytes: sub.storage_used_bytes,
    });
  });

  // Update subscription
  app.patch('/:id/subscription', protect, { preHandler: [requireOrgOwner] }, async (req, reply) => {
    const { plan, seats } = req.body;
    const update = {};
    if (plan) update.plan = plan;
    if (seats) update.seats = seats;

    await OrgSubscription.updateOne(
      { org_id: req.orgId },
      { $set: update }
    );

    return reply.send({ updated: true });
  });
}

module.exports = organizationRoutes;
```

- [ ] **Step 2: Register routes in server.js**

```js
// In src/server.js, add route registration
await app.register(require('./routes/organizations'), { prefix: '/organizations' });
```

- [ ] **Step 3: Test org CRUD**

Run: `cd Beaver-Sync && curl -X POST http://localhost:3000/organizations -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '{"name":"My Org"}'`
Expected: 201 with org details

- [ ] **Step 4: Commit**

```bash
git add src/routes/organizations.js src/server.js
git commit -m "feat(api): add organization CRUD endpoints"
```

---

### Task 7: Workspace Endpoints Update

**Files:**
- Modify: `Beaver-Sync/src/routes/workspaces.js`

**Interfaces:**
- Consumes: `Organization`, `OrgMember` models
- Produces: updated workspace endpoints with org_id

- [ ] **Step 1: Update workspace creation to require orgId**

```js
// In src/routes/workspaces.js, update POST / handler

app.post('/', {
  ...protect,
  config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
}, async (req, reply) => {
  const { name, orgId } = req.body;
  
  if (!name || !name.trim()) {
    return reply.status(400).send({ error: 'validation_error', message: 'Workspace name is required.' });
  }

  if (!orgId) {
    return reply.status(400).send({ error: 'validation_error', message: 'Organization ID is required.' });
  }

  // Verify user is member of the org
  const membership = await OrgMember.findOne({
    org_id: orgId,
    account_id: req.userId,
  }).lean();

  if (!membership) {
    return reply.status(403).send({ error: 'not_org_member' });
  }

  const workspace = await Workspace.create({
    nameEncrypted: name.trim(),
    orgId,
    createdAt: new Date(),
  });

  await WorkspaceMember.create({
    workspaceId: workspace.id,
    accountId: req.userId,
    role: 'owner',
    createdAt: new Date(),
  });

  return reply.status(201).send({
    id: workspace.id,
    name: name.trim(),
    role: 'owner',
  });
});
```

- [ ] **Step 2: Add workspace delete endpoint**

```js
// In src/routes/workspaces.js, add DELETE /:id handler

app.delete('/:id', protect, async (req, reply) => {
  const workspace = await Workspace.findById(req.params.id).lean();
  if (!workspace) {
    return reply.status(404).send({ error: 'not_found' });
  }

  // Check user is owner
  const membership = await WorkspaceMember.findOne({
    workspace_id: req.params.id,
    account_id: req.userId,
    role: 'owner',
  }).lean();

  if (!membership) {
    return reply.status(403).send({ error: 'not_workspace_owner' });
  }

  // Delete workspace data
  await WorkspaceMember.deleteMany({ workspace_id: req.params.id });
  await WorkspaceInvite.deleteMany({ workspace_id: req.params.id });
  await Workspace.deleteOne({ _id: req.params.id });

  return reply.send({ deleted: true });
});
```

- [ ] **Step 3: Update GET / to list workspaces across all user's orgs**

```js
// In src/routes/workspaces.js, update GET / handler

app.get('/', protect, async (req, reply) => {
  // Get all orgs user belongs to
  const memberships = await OrgMember.find({ account_id: req.userId }).lean();
  const orgIds = memberships.map(m => m.org_id);

  // Get all workspaces in those orgs
  const workspaces = await Workspace.find({ org_id: { $in: orgIds } }).lean();

  return reply.send(workspaces.map(ws => ({
    id: ws.id,
    name: ws.name_encrypted,
    orgId: ws.org_id,
    emoji: ws.emoji,
    color: ws.color,
  })));
});
```

- [ ] **Step 4: Commit**

```bash
git add src/routes/workspaces.js
git commit -m "feat(api): update workspace endpoints for org model"
```

---

### Task 8: Account Endpoint Update

**Files:**
- Modify: `Beaver-Sync/src/routes/account.js`

**Interfaces:**
- Consumes: `Organization`, `OrgMember`, `OrgSubscription`, `Workspace`, `WorkspaceMember` models
- Produces: enhanced GET /account response

- [ ] **Step 1: Update GET /account to return orgs and workspaces**

```js
// In src/routes/account.js, update GET / handler

app.get('/', {
  ...protect,
  config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
}, async (req, reply) => {
  const [account, memberships] = await Promise.all([
    Account.findById(req.userId, { username: 1, emailHmac: 1, emailEncrypted: 1, createdAt: 1 }).lean(),
    OrgMember.find({ account_id: req.userId }).lean(),
  ]);

  if (!account) {
    return reply.status(404).send({ error: 'not_found', message: 'Beaver Account not found.' });
  }

  // Get orgs with subscriptions and workspaces
  const orgIds = memberships.map(m => m.org_id);
  const [orgs, subscriptions, allWorkspaces] = await Promise.all([
    Organization.find({ _id: { $in: orgIds } }).lean(),
    OrgSubscription.find({ org_id: { $in: orgIds } }).lean(),
    Workspace.find({ org_id: { $in: orgIds } }).lean(),
  ]);

  const organizations = orgs.map(org => {
    const membership = memberships.find(m => m.org_id === org.id);
    const subscription = subscriptions.find(s => s.org_id === org.id);
    const workspaces = allWorkspaces.filter(ws => ws.org_id === org.id);

    return {
      id: org.id,
      name: org.name_encrypted,
      slug: org.slug,
      role: membership.role,
      subscription: subscription ? {
        plan: subscription.plan,
        status: subscription.status,
        seats: subscription.seats,
      } : null,
      workspaces: workspaces.map(ws => ({
        id: ws.id,
        name: ws.name_encrypted,
        emoji: ws.emoji,
        color: ws.color,
      })),
    };
  });

  return reply.send({
    user: {
      id: account.id,
      username: account.username,
      emailHash: account.emailHmac,
      kdfSalt: account.kdfSalt,
      createdAt: account.createdAt,
    },
    organizations,
  });
});
```

- [ ] **Step 2: Test account endpoint**

Run: `cd Beaver-Sync && curl http://localhost:3000/account -H "Authorization: Bearer <token>"`
Expected: Response with user, organizations (with workspaces and subscription)

- [ ] **Step 3: Commit**

```bash
git add src/routes/account.js
git commit -m "feat(api): enhance GET /account with orgs and workspaces"
```

---

## Phase 3: Backend — Yjs Unified Persistence

### Task 9: Yjs-Sync.js Rewrite

**Files:**
- Modify: `Beaver-Sync/src/routes/yjs-sync.js`

**Interfaces:**
- Consumes: `yjs_doc_updates` table, `persistence.storeUpdate/loadUpdatesSince/deleteUpdatesForNote`
- Produces: updated push/pull/delete endpoints

- [ ] **Step 1: Rewrite yjs-sync.js**

```js
// Beaver-Sync/src/routes/yjs-sync.js (full rewrite)

'use strict';

const { z } = require('zod');
const { YjsDocUpdate, Workspace, OrgSubscription } = require('../models');
const { requirePaidWrite, requireActiveSync } = require('../middleware/subscription');
const { getDb } = require('../db');

const PushSchema = z.object({
  workspaceId: z.string().min(1),
  noteId: z.string().min(1),
  updates: z.array(z.object({
    key: z.string(),
    data: z.string(),
  })),
});

const PullSchema = z.object({
  workspaceId: z.string().min(1),
  noteId: z.string().min(1),
  after: z.record(z.object({
    ts: z.number(),
    seq: z.number(),
  })).optional(),
});

const DeleteSchema = z.object({
  workspaceId: z.string().min(1),
  noteId: z.string().min(1),
  keys: z.array(z.string()),
});

async function yjsSyncRoutes(app) {
  await app.register(require('../middleware/auth'));
  
  const protect = {
    preHandler: [app.authenticate, requirePaidWrite],
  };

  // Push updates to SQLite
  app.post('/push', protect, async (req, reply) => {
    const parsed = PushSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error });
    }

    const { workspaceId, noteId, updates } = parsed.data;

    // Verify workspace access
    const workspace = await Workspace.findById(workspaceId).lean();
    if (!workspace) {
      return reply.status(404).send({ error: 'workspace_not_found' });
    }

    // Store each update in SQLite
    for (const update of updates) {
      const keyParts = update.key.split('.');
      const ts = parseInt(keyParts[keyParts.length - 2]) || Date.now();
      const seq = parseInt(keyParts[keyParts.length - 1]) || 0;
      const deviceId = keyParts[0] || 'unknown';

      await YjsDocUpdate.create({
        workspaceId,
        noteId,
        updateData: Buffer.from(update.data, 'base64'),
        deviceId,
        clock: seq,
        ts,
        createdAt: new Date(),
      });
    }

    // Update storage quota
    const subscription = await OrgSubscription.findOne({ org_id: workspace.org_id }).lean();
    if (subscription) {
      const totalSize = updates.reduce((sum, u) => sum + Buffer.byteLength(u.data, 'base64'), 0);
      await OrgSubscription.updateOne(
        { org_id: workspace.org_id },
        { $inc: { storage_used_bytes: totalSize } }
      );
    }

    return reply.send({ stored: updates.length });
  });

  // Pull updates from SQLite
  app.post('/pull', protect, async (req, reply) => {
    const parsed = PullSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error });
    }

    const { workspaceId, noteId, after = {} } = parsed.data;

    // Find minimum timestamp across all cursors
    const minTs = Object.values(after).reduce((min, cursor) => 
      Math.min(min, cursor.ts), Infinity);
    const effectiveMinTs = minTs === Infinity ? 0 : minTs;

    // Get updates from SQLite
    const updates = await YjsDocUpdate.find({
      workspace_id: workspaceId,
      note_id: noteId,
      ts: { $gt: effectiveMinTs },
    }).sort({ ts: 1, clock: 1 }).lean();

    // Filter out updates already seen by each device
    const filtered = updates.filter(update => {
      const cursor = after[update.device_id];
      if (!cursor) return true;
      if (update.ts > cursor.ts) return true;
      if (update.ts === cursor.ts && update.clock > cursor.seq) return true;
      return false;
    });

    // Format response
    const result = filtered.map(update => ({
      key: `${update.device_id}.${update.note_id}.${update.ts}.${update.clock}`,
      data: update.update_data.toString('base64'),
    }));

    return reply.send(result);
  });

  // Delete updates for a note
  app.delete('/updates', protect, async (req, reply) => {
    const parsed = DeleteSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error });
    }

    const { workspaceId, noteId } = parsed.data;

    await YjsDocUpdate.deleteMany({
      workspace_id: workspaceId,
      note_id: noteId,
    });

    return reply.send({ deleted: true });
  });
}

module.exports = yjsSyncRoutes;
```

- [ ] **Step 2: Test push endpoint**

Run: `cd Beaver-Sync && curl -X POST http://localhost:3000/yjs/push -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '{"workspaceId":"ws1","noteId":"note1","updates":[{"key":"device1.note1.1234567890.1","data":"dGVzdA=="}]}'`
Expected: 200 with `{ stored: 1 }`

- [ ] **Step 3: Commit**

```bash
git add src/routes/yjs-sync.js
git commit -m "feat(yjs): rewrite yjs-sync to use SQLite persistence"
```

---

### Task 10: Hocuspocus Hooks

**Files:**
- Modify: `Beaver-Sync/src/hocuspocus.js`

**Interfaces:**
- Consumes: `persistence` object, R2 service
- Produces: `onStoreDocument`, `onLoadDocument` hooks

- [ ] **Step 1: Add onStoreDocument hook**

```js
// In src/hocuspocus.js, add to configuration.extensions

onStoreDocument: async ({ document, documentName }) => {
  const [workspaceId, noteId] = documentName.split('/');
  
  try {
    // Serialize full Y.Doc state
    const state = Y.encodeStateAsUpdate(document);
    const stateBase64 = Buffer.from(state).toString('base64');
    
    // Write to R2
    const r2Key = `yjs/${workspaceId}/${noteId}.yjs`;
    await r2.put(r2Key, stateBase64);
    
    // Clear incremental updates from SQLite
    await YjsDocUpdate.deleteMany({
      workspace_id: workspaceId,
      note_id: noteId,
    });
    
    console.log(`[hocuspocus] Stored document ${documentName} to R2`);
  } catch (err) {
    console.error(`[hocuspocus] Failed to store document ${documentName}:`, err);
  }
},
```

- [ ] **Step 2: Add onLoadDocument hook**

```js
// In src/hocuspocus.js, add to configuration.extensions

onLoadDocument: async ({ document, documentName }) => {
  const [workspaceId, noteId] = documentName.split('/');
  
  try {
    // Try loading from R2 first
    const r2Key = `yjs/${workspaceId}/${noteId}.yjs`;
    const r2Data = await r2.get(r2Key);
    
    if (r2Data) {
      const state = Buffer.from(r2Data, 'base64');
      Y.applyUpdate(document, state);
      console.log(`[hocuspocus] Loaded document ${documentName} from R2`);
      return;
    }
    
    // Fall back to SQLite incremental updates
    const updates = await YjsDocUpdate.find({
      workspace_id: workspaceId,
      note_id: noteId,
    }).sort({ ts: 1, clock: 1 }).lean();
    
    for (const update of updates) {
      Y.applyUpdate(document, update.update_data);
    }
    
    console.log(`[hocuspocus] Loaded document ${documentName} from SQLite (${updates.length} updates)`);
  } catch (err) {
    console.error(`[hocuspocus] Failed to load document ${documentName}:`, err);
  }
},
```

- [ ] **Step 3: Commit**

```bash
git add src/hocuspocus.js
git commit -m "feat(hocuspocus): add onStoreDocument and onLoadDocument hooks"
```

---

### Task 11: Yjs Recovery Job

**Files:**
- Create: `Beaver-Sync/src/lib/yjs-recovery.js`

**Interfaces:**
- Consumes: `YjsDocUpdate` model, R2 service, Yjs `Doc`
- Produces: recovery function that flushes stale SQLite updates to R2

- [ ] **Step 1: Create recovery job**

```js
// Beaver-Sync/src/lib/yjs-recovery.js

'use strict';

const Y = require('yjs');
const { YjsDocUpdate } = require('../models');
const r2 = require('../services/r2');

const FLUSH_AGE_MS = parseInt(process.env.YJS_FLUSH_AGE_MS || '300000', 10); // 5 minutes

async function flushStaleDocuments() {
  const cutoff = new Date(Date.now() - FLUSH_AGE_MS);
  
  // Find documents with old updates
  const staleDocs = await YjsDocUpdate.aggregate([
    { $match: { created_at: { $lt: cutoff } } },
    { $group: { _id: { workspace_id: '$workspace_id', note_id: '$note_id' }, count: { $sum: 1 } } },
  ]);

  console.log(`[recovery] Found ${staleDocs.length} documents with stale updates`);

  for (const doc of staleDocs) {
    const { workspace_id, note_id } = doc._id;
    
    try {
      // Load all updates for this document
      const updates = await YjsDocUpdate.find({
        workspace_id,
        note_id,
      }).sort({ ts: 1, clock: 1 }).lean();

      if (updates.length === 0) continue;

      // Merge into full document state
      const ydoc = new Y.Doc();
      for (const update of updates) {
        Y.applyUpdate(ydoc, update.update_data);
      }

      // Write to R2
      const state = Y.encodeStateAsUpdate(ydoc);
      const stateBase64 = Buffer.from(state).toString('base64');
      const r2Key = `yjs/${workspace_id}/${note_id}.yjs`;
      await r2.put(r2Key, stateBase64);

      // Clear SQLite updates
      await YjsDocUpdate.deleteMany({
        workspace_id,
        note_id,
      });

      ydoc.destroy();
      console.log(`[recovery] Flushed ${workspace_id}/${note_id} (${updates.length} updates)`);
    } catch (err) {
      console.error(`[recovery] Failed to flush ${workspace_id}/${note_id}:`, err);
    }
  }
}

module.exports = { flushStaleDocuments };
```

- [ ] **Step 2: Wire recovery job to Hocuspocus startup**

```js
// In src/hocuspocus.js, add startup hook

const { flushStaleDocuments } = require('./lib/yjs-recovery');

// After server starts
async function onServerStart() {
  await flushStaleDocuments();
}

// Call on startup
onServerStart().catch(err => {
  console.error('[hocuspocus] Recovery job failed:', err);
});
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/yjs-recovery.js src/hocuspocus.js
git commit -m "feat(yjs): add crash recovery job for SQLite to R2 flush"
```

---

## Phase 4: Frontend — Account Store & Multi-Account

### Task 12: Account Store Redesign

**Files:**
- Modify: `Beaver-Notes/src/store/account.ts`

**Interfaces:**
- Consumes: `getAccount()` API response
- Produces: multi-account state with orgs and workspaces

- [ ] **Step 1: Redesign account store**

```typescript
// Beaver-Notes/src/store/account.ts

import { defineStore } from 'pinia';

interface Workspace {
  id: string;
  name: string;
  emoji?: string;
  color?: string;
}

interface Organization {
  id: string;
  name: string;
  slug: string;
  role: string;
  subscription: {
    plan: string;
    status: string;
    seats: number;
  } | null;
  workspaces: Workspace[];
}

interface Account {
  id: string;
  username: string;
  emailHash: string;
  token: string;
  serverUrl: string;
  organizations: Organization[];
}

interface AccountState {
  accounts: Account[];
  activeAccountId: string | null;
  activeOrgId: string | null;
  activeWorkspaceId: string | null;
}

export const useAccountStore = defineStore('account', {
  state: (): AccountState => ({
    accounts: [],
    activeAccountId: null,
    activeOrgId: null,
    activeWorkspaceId: null,
  }),

  getters: {
    activeAccount: (state) => 
      state.accounts.find(a => a.id === state.activeAccountId) ?? null,
    
    activeOrg: (state) => {
      const account = state.accounts.find(a => a.id === state.activeAccountId);
      return account?.organizations.find(o => o.id === state.activeOrgId) ?? null;
    },
    
    activeWorkspace: (state) => {
      const org = this.activeOrg;
      return org?.workspaces.find(w => w.id === state.activeWorkspaceId) ?? null;
    },
    
    allAccounts: (state) => state.accounts,
    
    isAuthenticated: (state) => state.accounts.length > 0,
    
    isPaidPlan: (state) => {
      const org = this.activeOrg;
      return org?.subscription?.plan !== 'free';
    },
    
    subscription: (state) => {
      const org = this.activeOrg;
      return org?.subscription ?? null;
    },
  },

  actions: {
    addAccount(account: Account) {
      this.accounts.push(account);
      this.activeAccountId = account.id;
      
      // Set default org and workspace
      if (account.organizations.length > 0) {
        this.activeOrgId = account.organizations[0].id;
        if (account.organizations[0].workspaces.length > 0) {
          this.activeWorkspaceId = account.organizations[0].workspaces[0].id;
        }
      }
    },
    
    removeAccount(accountId: string) {
      this.accounts = this.accounts.filter(a => a.id !== accountId);
      if (this.activeAccountId === accountId) {
        this.activeAccountId = this.accounts[0]?.id ?? null;
        if (this.activeAccountId) {
          const account = this.accounts[0];
          this.activeOrgId = account.organizations[0]?.id ?? null;
          this.activeWorkspaceId = account.organizations[0]?.workspaces[0]?.id ?? null;
        }
      }
    },
    
    switchAccount(accountId: string) {
      this.activeAccountId = accountId;
      const account = this.accounts.find(a => a.id === accountId);
      if (account) {
        this.activeOrgId = account.organizations[0]?.id ?? null;
        this.activeWorkspaceId = account.organizations[0]?.workspaces[0]?.id ?? null;
      }
    },
    
    switchOrg(orgId: string) {
      this.activeOrgId = orgId;
      const org = this.activeOrg;
      if (org) {
        this.activeWorkspaceId = org.workspaces[0]?.id ?? null;
      }
    },
    
    switchWorkspace(workspaceId: string) {
      this.activeWorkspaceId = workspaceId;
    },
    
    setProfile(profile: any) {
      // Legacy compatibility
    },
    
    setSubscription(subscription: any) {
      // Legacy compatibility
    },
    
    setDevices(devices: any[]) {
      // Legacy compatibility
    },
    
    setActiveSessions(sessions: any[]) {
      // Legacy compatibility
    },
  },
});
```

- [ ] **Step 2: Update account store imports**

```js
// In Beaver-Notes/src/store/account.ts, add missing imports
import { defineStore } from 'pinia';
```

- [ ] **Step 3: Commit**

```bash
git add Beaver-Notes/src/store/account.ts
git commit -m "feat(store): redesign account store for multi-account and orgs"
```

---

### Task 13: UserAvatar Component

**Files:**
- Create: `Beaver-Notes/src/components/ui/UserAvatar.vue`

**Interfaces:**
- Consumes: `name` prop
- Produces: rendered avatar with initials and color

- [ ] **Step 1: Create UserAvatar component**

```vue
<!-- Beaver-Notes/src/components/ui/UserAvatar.vue -->

<template>
  <div
    class="inline-flex items-center justify-center rounded-full text-white font-medium"
    :style="{
      backgroundColor: bgColor,
      width: size + 'px',
      height: size + 'px',
      fontSize: size * 0.4 + 'px',
    }"
  >
    {{ initials }}
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  name: { type: String, default: '' },
  size: { type: Number, default: 32 },
});

const initials = computed(() => {
  const words = props.name.trim().split(/\s+/);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return (words[0]?.[0] || '?').toUpperCase();
});

const bgColor = computed(() => {
  let hash = 0;
  for (const c of props.name) hash = ((hash << 5) - hash + c.charCodeAt(0)) | 0;
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 45%)`;
});
</script>
```

- [ ] **Step 2: Register component globally**

```js
// In Beaver-Notes/src/lib/comps-ui.js, add UserAvatar
import UserAvatar from '@/components/ui/UserAvatar.vue';

app.component('UiUserAvatar', UserAvatar);
```

- [ ] **Step 3: Commit**

```bash
git add Beaver-Notes/src/components/ui/UserAvatar.vue Beaver-Notes/src/lib/comps-ui.js
git commit -m "feat(ui): add UserAvatar component with initials"
```

---

## Phase 5: Frontend — Sidebar & Navigation

### Task 14: Sidebar Redesign

**Files:**
- Modify: `Beaver-Notes/src/components/app/AppSidebar.vue`
- Modify: `Beaver-Notes/src/components/app/WorkspaceSwitcher.vue`

**Interfaces:**
- Consumes: `accountStore` (multi-account state)
- Produces: org/workspace sections in sidebar

- [ ] **Step 1: Add account switcher to sidebar**

```vue
<!-- In AppSidebar.vue, add account switcher section -->

<template>
  <div class="sidebar">
    <!-- Account Switcher -->
    <div class="account-switcher">
      <ui-popover placement="bottom-start">
        <template #trigger>
          <div class="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded-lg">
            <UiUserAvatar :name="activeAccount?.username || 'User'" :size="24" />
            <span class="text-sm font-medium truncate">{{ activeAccount?.username || 'Account' }}</span>
            <v-remixicon name="riArrowDownSLine" size="16" />
          </div>
        </template>
        
        <div class="min-w-[200px]">
          <div v-for="account in allAccounts" :key="account.id" class="p-1">
            <button
              class="flex items-center gap-2 w-full p-2 rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-800"
              :class="account.id === activeAccountId ? 'bg-neutral-100 dark:bg-neutral-800' : ''"
              @click="switchAccount(account.id)"
            >
              <UiUserAvatar :name="account.username" :size="20" />
              <span class="text-sm">{{ account.username }}</span>
              <v-remixicon v-if="account.id === activeAccountId" name="riCheckLine" size="16" class="ml-auto text-primary" />
            </button>
          </div>
          <div class="border-t border-neutral-200 dark:border-neutral-700 my-1" />
          <button class="flex items-center gap-2 w-full p-2 text-sm text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded-lg" @click="addAccount">
            <v-remixicon name="riAddLine" size="16" />
            <span>Add Account</span>
          </button>
        </div>
      </ui-popover>
    </div>
    
    <!-- Org Sections -->
    <div class="org-sections">
      <div v-for="org in activeOrgs" :key="org.id" class="org-section">
        <div class="flex items-center gap-2 px-3 py-2 text-xs font-medium text-neutral-500 uppercase">
          <span>{{ org.name }}</span>
        </div>
        
        <div v-for="workspace in org.workspaces" :key="workspace.id" class="px-2">
          <button
            class="flex items-center gap-2 w-full p-2 rounded-lg text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
            :class="workspace.id === activeWorkspaceId ? 'bg-primary/10 text-primary' : 'text-neutral-700 dark:text-neutral-300'"
            @click="switchWorkspace(org.id, workspace.id)"
          >
            <span v-if="workspace.emoji">{{ workspace.emoji }}</span>
            <v-remixicon v-else name="riFolderLine" size="16" />
            <span class="truncate">{{ workspace.name }}</span>
            <v-remixicon v-if="workspace.id === activeWorkspaceId" name="riCheckLine" size="16" class="ml-auto" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { useAccountStore } from '@/store/account';

const accountStore = useAccountStore();

const activeAccount = computed(() => accountStore.activeAccount);
const allAccounts = computed(() => accountStore.allAccounts);
const activeAccountId = computed(() => accountStore.activeAccountId);
const activeOrgs = computed(() => activeAccount.value?.organizations ?? []);
const activeWorkspaceId = computed(() => accountStore.activeWorkspaceId);

function switchAccount(accountId) {
  accountStore.switchAccount(accountId);
  window.location.reload();
}

function switchWorkspace(orgId, workspaceId) {
  accountStore.switchOrg(orgId);
  accountStore.switchWorkspace(workspaceId);
  window.location.reload();
}

function addAccount() {
  // TODO: implement add account flow
}
</script>
```

- [ ] **Step 2: Update WorkspaceSwitcher.vue to use new store**

```js
// In WorkspaceSwitcher.vue, update to use accountStore
import { useAccountStore } from '@/store/account';

const accountStore = useAccountStore();
const workspaces = computed(() => accountStore.activeOrg?.workspaces ?? []);
const activeId = computed(() => accountStore.activeWorkspaceId);
```

- [ ] **Step 3: Commit**

```bash
git add Beaver-Notes/src/components/app/AppSidebar.vue Beaver-Notes/src/components/app/WorkspaceSwitcher.vue
git commit -m "feat(sidebar): add account switcher and org sections"
```

---

### Task 15: Workspace Emoji/Color Picker

**Files:**
- Modify: `Beaver-Notes/src/components/app/WorkspaceSwitcher.vue`

**Interfaces:**
- Consumes: workspace data
- Produces: emoji/color picker in create/edit workspace dialog

- [ ] **Step 1: Add emoji/color picker to workspace creation**

```vue
<!-- In WorkspaceSwitcher.vue, update promptCreate function -->

function promptCreate() {
  emitter.emit('show-dialog', 'prompt', {
    title: 'New Workspace',
    placeholder: 'Workspace name',
    okText: 'Create',
    password: false,
    fields: [
      { key: 'name', type: 'text', placeholder: 'Workspace name' },
      { key: 'emoji', type: 'emoji', placeholder: 'Choose emoji' },
      { key: 'color', type: 'color', placeholder: 'Choose color' },
    ],
    async onConfirm(data) {
      if (!data.name || !data.name.trim()) return;
      const ws = await workspaceStore.create(data.name.trim(), {
        emoji: data.emoji,
        color: data.color,
      });
      await workspaceStore.switchTo(ws.id);
      clearSettingsLocalStorage();
      window.location.reload();
    },
  });
}
```

- [ ] **Step 2: Add emoji/color to workspace store**

```js
// In useCloudWorkspaces.js, update createWorkspace to include emoji/color
async function createWorkspace(name, { emoji, color } = {}) {
  const raw = await apiCreateWorkspace(name, { emoji, color }, { baseUrl: activeBaseUrl() });
  // ...
}
```

- [ ] **Step 3: Commit**

```bash
git add Beaver-Notes/src/components/app/WorkspaceSwitcher.vue Beaver-Notes/src/composable/useCloudWorkspaces.js
git commit -m "feat(workspace): add emoji and color picker"
```

---

## Phase 6: Frontend — Yjs Sync Updates

### Task 16: Remote-Yjs.js Update

**Files:**
- Modify: `Beaver-Notes/src/utils/sync/remote-yjs.js`

**Interfaces:**
- Consumes: `accountStore.activeWorkspaceId`
- Produces: updated push/pull/delete functions with workspaceId + noteId

- [ ] **Step 1: Update remote-yjs.js functions**

```js
// Beaver-Notes/src/utils/sync/remote-yjs.js

import { useAccountStore } from '@/store/account';

export async function pushUpdates(noteId, updates) {
  const accountStore = useAccountStore();
  const workspaceId = accountStore.activeWorkspaceId;
  
  if (!workspaceId) throw new Error('No active workspace');
  
  const response = await fetch('/yjs/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accountStore.activeAccount?.token}`,
    },
    body: JSON.stringify({ workspaceId, noteId, updates }),
  });
  
  if (!response.ok) throw new Error(`Push failed: ${response.status}`);
  return response.json();
}

export async function pullUpdates(noteId, cursors = {}) {
  const accountStore = useAccountStore();
  const workspaceId = accountStore.activeWorkspaceId;
  
  if (!workspaceId) throw new Error('No active workspace');
  
  const response = await fetch('/yjs/pull', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accountStore.activeAccount?.token}`,
    },
    body: JSON.stringify({ workspaceId, noteId, after: cursors }),
  });
  
  if (!response.ok) throw new Error(`Pull failed: ${response.status}`);
  return response.json();
}

export async function deleteRemoteUpdates(noteId, keys) {
  const accountStore = useAccountStore();
  const workspaceId = accountStore.activeWorkspaceId;
  
  if (!workspaceId) throw new Error('No active workspace');
  
  const response = await fetch('/yjs/updates', {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accountStore.activeAccount?.token}`,
    },
    body: JSON.stringify({ workspaceId, noteId, keys }),
  });
  
  if (!response.ok) throw new Error(`Delete failed: ${response.status}`);
  return response.json();
}
```

- [ ] **Step 2: Commit**

```bash
git add Beaver-Notes/src/utils/sync/remote-yjs.js
git commit -m "feat(sync): update remote-yjs for workspaceId + noteId"
```

---

### Task 17: Cloud Transport Update

**Files:**
- Modify: `Beaver-Notes/src/utils/sync/transports/cloud.js`

**Interfaces:**
- Consumes: `accountStore.activeWorkspaceId`
- Produces: updated push/pull with workspace context

- [ ] **Step 1: Update cloud transport**

```js
// In cloud.js, update _getWorkspaceId and push/pull methods

import { useAccountStore } from '@/store/account';

_getWorkspaceId() {
  const accountStore = useAccountStore();
  return accountStore.activeWorkspaceId;
}

async push(cursors, opts = {}) {
  const workspaceId = this._getWorkspaceId();
  if (!workspaceId) {
    console.log('[sync] cloud push: no active workspace');
    return { updates: [], cursorsDelta: {}, pushed: 0 };
  }
  
  // ... rest of push implementation using workspaceId
}

async pull(cursors) {
  const workspaceId = this._getWorkspaceId();
  if (!workspaceId) {
    console.log('[sync] cloud pull: no active workspace');
    return { updates: [], cursorsDelta: {} };
  }
  
  // ... rest of pull implementation using workspaceId
}
```

- [ ] **Step 2: Commit**

```bash
git add Beaver-Notes/src/utils/sync/transports/cloud.js
git commit -m "feat(sync): update cloud transport for workspace context"
```

---

## Phase 7: Frontend — Missing Features

### Task 18: Wire Up Missing Features

**Files:**
- Modify: `Beaver-Notes/src/pages/settings/Account.vue`
- Modify: `Beaver-Notes/src/pages/settings/Data.vue`
- Modify: `Beaver-Notes/src/utils/sync/transports/cloud.js`

**Interfaces:**
- Consumes: existing backend endpoints
- Produces: UI for workspace delete, account export, username update, asset deletion

- [ ] **Step 1: Add workspace delete confirmation**

```js
// In WorkspaceSwitcher.vue, add deleteWorkspace function
async function deleteWorkspace(id) {
  const confirmed = await dialog.confirm({
    title: 'Delete Workspace',
    message: 'Are you sure you want to delete this workspace? This action cannot be undone.',
    type: 'danger',
  });
  
  if (confirmed) {
    await workspaceStore.remove(id);
    clearSettingsLocalStorage();
    window.location.reload();
  }
}
```

- [ ] **Step 2: Add account export button**

```vue
<!-- In Account.vue, add export button -->
<ui-button @click="exportAccount">
  <v-remixicon name="riDownloadLine" size="16" />
  Export Data
</ui-button>

<script setup>
async function exportAccount() {
  const response = await fetch('/account/export', {
    headers: { 'Authorization': `Bearer ${accountStore.activeAccount?.token}` },
  });
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'beaver-account-export.zip';
  a.click();
  URL.revokeObjectURL(url);
}
</script>
```

- [ ] **Step 3: Add username update inline**

```vue
<!-- In Account.vue, add username edit -->
<div class="flex items-center gap-2">
  <span class="text-sm text-neutral-500">Username:</span>
  <input v-model="username" class="input" @blur="updateUsername" />
</div>

<script setup>
const username = ref(accountStore.activeAccount?.username || '');

async function updateUsername() {
  if (username.value.trim()) {
    await accountApi.updateUsername(username.value.trim(), {
      baseUrl: accountStore.activeAccount?.serverUrl,
    });
  }
}
</script>
```

- [ ] **Step 4: Add asset deletion to sync loop**

```js
// In cloud.js push method, after pushing updates
if (deletedAssets.length > 0) {
  for (const asset of deletedAssets) {
    await deleteRemoteAsset(asset.key).catch(err => {
      console.warn('[sync] Failed to delete remote asset:', err);
    });
  }
}
```

- [ ] **Step 5: Commit**

```bash
git add Beaver-Notes/src/pages/settings/Account.vue Beaver-Notes/src/components/app/WorkspaceSwitcher.vue Beaver-Notes/src/utils/sync/transports/cloud.js
git commit -m "feat(settings): wire up missing features"
```

---

## Verification

After completing all tasks, verify:

1. **Backend starts without errors:**
   ```bash
   cd Beaver-Sync && npm start
   ```

2. **Registration creates personal org:**
   ```bash
   curl -X POST http://localhost:3000/auth/register -H "Content-Type: application/json" -d '{"email":"test@example.com","password":"123456789012"}'
   ```

3. **Org endpoints work:**
   ```bash
   curl http://localhost:3000/organizations -H "Authorization: Bearer <token>"
   ```

4. **Yjs push/pull work:**
   ```bash
   curl -X POST http://localhost:3000/yjs/push -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '{"workspaceId":"<id>","noteId":"note1","updates":[{"key":"device1.note1.1234567890.1","data":"dGVzdA=="}]}'
   ```

5. **Frontend builds:**
   ```bash
   cd Beaver-Notes && npm run build
   ```

6. **No circular dependencies:**
   ```bash
   cd Beaver-Notes && npx madge --circular src/
   ```

---

**Plan complete and saved to `Beaver-Sync/docs/multi-account-org-yjs-plan.md`.**

Two execution options:

1. **Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
