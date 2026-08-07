# Multi-Account + Organization + Unified Yjs Persistence — Design Spec

**Date:** 2026-08-04
**Status:** Draft
**Supersedes:** `yjs-unified-persistence.md` (merged into this spec)

---

## 1. Purpose & Scope

Redesign the account/workspace model so that:

- Users can have multiple accounts on one device (instant switching, like Slack/Discord)
- Organizations are the billing entity (not accounts or workspaces)
- Every user gets a personal organization with a default workspace
- Companies get orgs with seat-based billing and multiple workspaces
- Users can belong to multiple organizations

**In scope:**
- Backend: new `organizations`, `org_members`, `org_subscriptions` tables; `workspaces.org_id` FK
- Backend: registration flow creates personal org + default workspace
- Backend: org CRUD, membership, invitation APIs
- Backend: billing moves from per-account to per-org
- Backend: Yjs unified persistence (SQLite as single source of truth, R2 as backup)
- Backend: Hocuspocus onStoreDocument/onLoadDocument hooks
- Backend: Yjs-sync.js rewrite (workspaceId + noteId in all endpoints)
- Backend: Yjs crash recovery job
- Frontend: account switcher (instant, multi-account)
- Frontend: org/workspace switcher in sidebar
- Frontend: profile images (auto-generated initials)
- Frontend: workspace emojis and colors
- Frontend: Yjs sync functions updated for workspaceId + noteId
- Frontend: wire up missing features (admin, audit, snapshots, SSO, vault, workspace delete)

**Out of scope:**
- Payment provider integration (Stripe/Apple/Google webhooks)
- SSO configuration UI (backend routes exist, no frontend)
- Real-time collaboration UI changes
- Onboarding flow redesign

---

## 2. Data Model

### 2.1 New tables

#### `organizations`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `name_encrypted` | TEXT NOT NULL | ML-KEM encrypted name |
| `slug` | TEXT UNIQUE | URL-friendly identifier (auto-generated from name) |
| `created_at` | TEXT NOT NULL | ISO timestamp |

Every user gets a personal org on registration, named after their username/email.

#### `org_members`

| Column | Type | Notes |
|---|---|---|
| `org_id` | TEXT NOT NULL FK→organizations | Composite PK part 1 |
| `account_id` | TEXT NOT NULL FK→accounts | Composite PK part 2 |
| `role` | TEXT NOT NULL | CHECK IN ('owner', 'admin', 'member') |
| `created_at` | TEXT NOT NULL | |

Owner can transfer ownership. Admins can manage members and billing. Members have read/write access to org workspaces.

#### `org_subscriptions`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | |
| `org_id` | TEXT NOT NULL UNIQUE FK→organizations | One subscription per org |
| `plan` | TEXT NOT NULL | CHECK IN ('free', 'basic', 'pro', 'team', 'enterprise') |
| `status` | TEXT DEFAULT 'active' | CHECK IN ('active', 'grace_period', 'expired') |
| `seats` | INTEGER DEFAULT 1 | Number of paid seats |
| `provider` | TEXT | CHECK IN ('stripe', 'apple', 'google') |
| `renews_at` | TEXT | |
| `stripe_customer_id` | TEXT | |
| `stripe_subscription_id` | TEXT | |
| `storage_quota_bytes` | INTEGER DEFAULT 0 | |
| `storage_used_bytes` | INTEGER DEFAULT 0 | |
| `created_at` | TEXT NOT NULL | |

### 2.2 Modified tables

#### `workspaces`

| Change | Details |
|---|---|
| Add `org_id` (TEXT, NOT NULL FK→organizations) | Every workspace belongs to an org |
| Add `emoji` (TEXT, nullable) | Workspace emoji for sidebar |
| Add `color` (TEXT, nullable) | Workspace color for sidebar |
| Remove `owner_id` | Ownership is now through org membership |

Migration: existing workspaces get `owner_id` → look up or create personal org → set `org_id`.

#### `subscriptions`

**Removed.** Billing moves to `org_subscriptions`.

Migration: migrate existing subscription data to `org_subscriptions` tied to the user's personal org.

### 2.3 Unchanged tables

- `accounts` — no changes
- `workspace_members` — still links accounts to workspaces with roles
- `workspace_invites` — still token-based invites
- `sessions` — stays per-account (each session belongs to one account)
- `commits` — stays per-account with optional workspace link
- `yjs_doc_updates` — stays workspace-scoped
- `collaboration_keys`, `note_invitations`, `note_invite_links` — note-scoped, unchanged
- `audit_logs` — stays account-scoped with optional workspace link

### 2.4 Profile images

No new table. Initials are computed client-side:
- Take first letter of each word in username (or email local part)
- Max 2 characters, uppercase
- Background color derived from name hash (consistent per user)
- Rendered as a colored circle with white text

### 2.5 Entity relationship

```
Account ──< OrgMember >── Organization ──< Workspace ──< WorkspaceMember >── Account
                                   │
                                   └──< OrgSubscription
```

---

## 3. Backend Changes

### 3.1 Registration flow

```
POST /auth/register
  1. Create account
  2. Create personal org (name = username or email local part)
  3. Add account as org owner
  4. Create default workspace in personal org (name = "Default" or "My Workspace")
  5. Add account as workspace owner
  6. Create free-tier org_subscription (1 seat)
  7. Create session
  8. Return token + org + workspace info
```

### 3.2 New API endpoints

#### Organizations

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `GET` | `/organizations` | user | List orgs user belongs to |
| `POST` | `/organizations` | user | Create new org |
| `GET` | `/organizations/:id` | org member | Get org details |
| `PATCH` | `/organizations/:id` | org owner/admin | Update org name |
| `DELETE` | `/organizations/:id` | org owner | Delete org (must transfer or remove all workspaces first) |

#### Org members

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `GET` | `/organizations/:id/members` | org member | List members |
| `POST` | `/organizations/:id/members` | org owner/admin | Add member (by email or user ID) |
| `PATCH` | `/organizations/:id/members/:uid` | org owner | Update member role |
| `DELETE` | `/organizations/:id/members/:uid` | org owner/admin | Remove member |
| `POST` | `/organizations/:id/leave` | org member | Leave org (cannot leave if owner) |

#### Org invitations

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `POST` | `/organizations/:id/invite` | org owner/admin | Generate invite link |
| `GET` | `/organizations/:id/invite` | org member | List pending invites |
| `DELETE` | `/organizations/:id/invite/:token` | org owner/admin | Revoke invite |
| `POST` | `/organizations/join/:token` | user | Join org via invite |

#### Org subscriptions

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `GET` | `/organizations/:id/subscription` | org owner/admin | Get subscription details |
| `PATCH` | `/organizations/:id/subscription` | org owner | Update plan/seats |

#### Workspace changes

| Method | Endpoint | Change |
|---|---|---|
| `POST` | `/workspaces` | Body now requires `orgId` instead of inferring from account |
| `GET` | `/workspaces` | List workspaces across all user's orgs |
| `DELETE` | `/workspaces/:id` | **New endpoint** (frontend already calls this) |

### 3.3 Modified endpoints

#### `GET /account`

Return additional data:
```json
{
  "user": { "id", "username", "emailHash", "kdfSalt", "createdAt" },
  "organizations": [
    {
      "id", "name", "role",
      "subscription": { "plan", "status", "seats" },
      "workspaces": [
        { "id", "name", "role", "emoji", "color" }
      ]
    }
  ]
}
```

This single response gives the frontend everything it needs to render the sidebar.

### 3.4 Auth middleware changes

The existing `app.authenticate` middleware validates the session and sets `req.userId`. For org-scoped endpoints, add an `requireOrgMember` middleware that:
1. Reads `:id` from params
2. Looks up `org_members` for `(org_id, req.userId)`
3. Sets `req.orgRole` and `req.orgId`
4. Returns 403 if not a member

### 3.5 Database migration

```sql
-- 1. Create organizations table
CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name_encrypted TEXT NOT NULL,
  slug TEXT UNIQUE,
  created_at TEXT NOT NULL
);

-- 2. Create org_members table
CREATE TABLE org_members (
  org_id TEXT NOT NULL REFERENCES organizations(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  role TEXT NOT NULL CHECK(role IN ('owner', 'admin', 'member')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, account_id)
);

-- 3. Create org_subscriptions table
CREATE TABLE org_subscriptions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL UNIQUE REFERENCES organizations(id),
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

-- 6. Migrate existing data
-- For each account with a workspace:
--   a. Create personal org
--   b. Add account as owner
--   c. Set workspace.org_id = personal org id
--   d. Migrate subscription to org_subscriptions

-- 7. Remove owner_id from workspaces (after migration)
-- ALTER TABLE workspaces DROP COLUMN owner_id;  -- SQLite doesn't support DROP COLUMN; recreate table

-- 8. Remove subscriptions table (after migration)
-- DROP TABLE subscriptions;  -- Keep as backup for one release
```

---

## 4. Frontend Changes

### 4.1 Account store

Current: single `accountStore` with one profile, one subscription, one token.

New: `accountStore` manages multiple accounts.

```js
// State
{
  accounts: [
    {
      id, username, emailHash, token, serverUrl,
      organizations: [
        {
          id, name, role,
          subscription: { plan, status, seats },
          workspaces: [
            { id, name, role, emoji, color }
          ]
        }
      ]
    }
  ],
  activeAccountId: string | null,
  activeOrgId: string | null,
  activeWorkspaceId: string | null,
}
```

Computed:
- `activeAccount` → current account object
- `activeOrg` → current org within active account
- `activeWorkspace` → current workspace within active org
- `allAccounts` → list of all logged-in accounts

### 4.2 Sidebar redesign

```
┌─────────────────────────────┐
│  [Avatar] Dani's Account  ▾ │  ← Account switcher
├─────────────────────────────┤
│  🏠 Personal                │  ← Org section header
│    📁 Default Workspace  ✓  │
│    📁 Work Projects         │
│  ─────────────────────────  │
│  🏢 Acme Corp              │  ← Org section header
│    📁 Engineering           │
│    📁 Marketing             │
│  ─────────────────────────  │
│  ➕ New Workspace           │
│  🔗 Join Workspace          │
├─────────────────────────────┤
│  ⚙️ Settings                │
│  🔄 Sync                    │
└─────────────────────────────┘
```

Account switcher: clicking the avatar/account name shows a dropdown of all logged-in accounts, with options to add another account or sign out.

Org sections: each org is a collapsible section showing its workspaces. Active workspace has a checkmark.

### 4.3 Profile image component

New component: `UserAvatar.vue`

```vue
<template>
  <div
    class="inline-flex items-center justify-center rounded-full text-white font-medium"
    :style="{ backgroundColor: bgColor, width: size + 'px', height: size + 'px', fontSize: size * 0.4 + 'px' }"
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

// Consistent color from name hash
const bgColor = computed(() => {
  let hash = 0;
  for (const c of props.name) hash = ((hash << 5) - hash + c.charCodeAt(0)) | 0;
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 45%)`;
});
</script>
```

Usage:
- Sidebar: next to account name
- Settings/Account: as profile image
- Collaboration: alongside user names in presence avatars

### 4.4 Workspace emoji/color picker

When creating or editing a workspace, show an emoji picker and a color selector (predefined palette of 8-12 colors). Stored as `emoji` and `color` fields on the workspace.

### 4.5 Settings pages to wire up

| Page | What to add |
|---|---|
| Account | Multi-account management (add/remove accounts, switch) |
| New: Organizations | Org CRUD, member management, invite links |
| New: Billing | Per-org subscription management (plan, seats, payment) |
| Security | Existing passkey/password + new "Active sessions per account" |
| Data | Existing sync settings (no change needed) |
| New: Audit | Org-level audit logs (for org admins) |

### 4.6 Missing features to wire up

| Feature | Backend endpoint | Frontend action |
|---|---|---|
| Workspace delete | `DELETE /workspaces/:id` | Add confirmation dialog + call |
| Account export | `GET /account/export` | Add "Export data" button in Account settings |
| Username update | `PATCH /account/username` | Add inline edit in Account settings |
| Asset deletion | `DELETE /assets/:key` | Wire into sync loop after push |
| Server-side snapshots | `GET/POST /snapshot` | Wire into sync engine for compaction |

---

## 5. Yjs Unified Persistence

### 5.1 Problem

Two disconnected persistence paths for Yjs data:

1. **Hocuspocus (WebSocket)** → SQLite (`yjs_doc_updates` table)
2. **REST API (`/yjs/push`, `/yjs/pull`)** → Cloudflare R2 (individual files)

These paths don't share state. A user editing via WebSocket can't be seen by a device syncing via REST. Every Yjs update was an individual R2 PUT ($5/M writes).

### 5.2 Solution

SQLite is the single source of truth for all Yjs updates. R2 holds full document snapshots as a durable backup, written only on session close (1 PUT per document, not per update).

### 5.3 Backend changes

#### `src/hocuspocus.js`

- **Removed** dead `POST /workspaces/is-member` fetch
- **Added `onStoreDocument` hook**: when all clients disconnect from a document, serialize full Y.Doc state via `document.toBinary()`, write to R2 at `yjs/{workspaceId}/{noteId}.yjs` (1 PUT), clear incremental updates from SQLite
- **Updated `onLoadDocument`**: check R2 first for full snapshot, fall back to incremental updates from SQLite
- **Wired recovery job** on startup to flush any SQLite updates that didn't make it to R2 before a crash

#### `src/routes/yjs-sync.js` (full rewrite)

**Breaking change:** All endpoints now require `workspaceId` and `noteId` in the request body.

- `POST /yjs/push` — Schema: `{ workspaceId, noteId, updates: [{key, data}] }`
  - Writes to SQLite via `persistence.storeUpdate()` instead of R2
  - Parses filename to extract timestamp for the `ts` field
  - Still updates storage quota on org subscriptions

- `POST /yjs/pull` — Schema: `{ workspaceId, noteId, after: { deviceId: { ts, seq } } }`
  - Reads from SQLite via `persistence.loadUpdatesSince()` instead of R2
  - Finds minimum timestamp across all device cursors
  - Filters out updates already seen by each device
  - Returns updates in the format `{ key, data }` (base64)

- `DELETE /yjs/updates` — Schema: `{ workspaceId, noteId, keys: [...] }`
  - Deletes all updates for the note via `persistence.deleteUpdatesForNote()`

#### `src/lib/yjs-recovery.js` (new file)

Background recovery job for crash safety:
- Queries SQLite for documents with updates older than 5 minutes (configurable via `YJS_FLUSH_AGE_MS`)
- Merges incremental updates into full document state using Yjs `Doc`
- Writes to R2, clears SQLite after successful write
- Runs on Hocuspocus startup

### 5.4 Frontend changes

#### `src/utils/sync/remote-yjs.js`

Updated function signatures to accept `workspaceId` and `noteId`:

```js
pushUpdates(workspaceId, noteId, updates)
pullUpdates(workspaceId, noteId, cursors)
deleteRemoteUpdates(workspaceId, noteId, keys)
```

All three send `workspaceId` and `noteId` in the request body.

#### `src/utils/sync/transports/cloud.js`

Updated `CloudTransport` to provide workspace context:

- `_getWorkspaceId()` — returns `accountStore.activeWorkspaceId`
- `pull()` — gets workspaceId, groups cursor keys by noteId (format `{noteId}:{deviceId}`), makes per-note pull requests
- `push()` — gets workspaceId, groups files by noteId (parsed from sync filename), makes per-note push requests

### 5.5 Data flow

```
                    ┌─────────────────────────────────────────┐
                    │           ACTIVE SESSION                 │
                    │                                         │
  Client A ──WS──► Hocuspocus ──storeUpdate()──► SQLite     │
  Client B ──WS──► Hocuspocus ──storeUpdate()──► SQLite     │
  Client C ──REST─► /yjs/push ──storeUpdate()──► SQLite     │
                    │                                         │
                    │  (all paths write to same SQLite)       │
                    └─────────────────────────────────────────┘
                                      │
                                      ▼
                    ┌─────────────────────────────────────────┐
                    │        SESSION CLOSE                     │
                    │                                         │
                    │  Hocuspocus ──document.toBinary()──►   │
                    │                 R2 (1 PUT)              │
                    │                                         │
                    │  SQLite updates cleared                 │
                    └─────────────────────────────────────────┘
                                      │
                                      ▼
                    ┌─────────────────────────────────────────┐
                    │        CROSS-DEVICE SYNC                 │
                    │                                         │
                    │  Client ──POST /yjs/pull──► SQLite      │
                    │  Client ──POST /yjs/push──► SQLite      │
                    │                                         │
                    │  (same persistence as Hocuspocus)       │
                    └─────────────────────────────────────────┘
                                      │
                                      ▼
                    ┌─────────────────────────────────────────┐
                    │        CRASH RECOVERY                    │
                    │                                         │
                    │  Startup:                               │
                    │    SQLite ──merge──► R2 (batch)         │
                    │                                         │
                    └─────────────────────────────────────────┘
```

### 5.6 Cost impact

| Operation | Before | After |
|-----------|--------|-------|
| R2 PUTs per Yjs session | N (one per update) | 1 (full doc on close) |
| R2 reads per pull | N (listKeys + get per key) | 0 (SQLite) |
| R2 reads per push | N (one per update) | 0 (SQLite) |
| SQLite writes per update | 1 (Hocuspocus only) | 1 (unified) |
| Crash data loss risk | High (R2 not written) | Low (SQLite durable + recovery) |

**Estimated R2 operation reduction: ~95%**

### 5.7 Multi-account integration

- **SQLite is per-workspace**: `yjs_doc_updates` already has `workspace_id`. No change needed.
- **R2 snapshots are per-workspace**: stored at `yjs/{workspaceId}/{noteId}.yjs`. No change needed.
- **Hocuspocus connections are per-workspace**: the `workspaceId` is already passed in the auth handshake. No change needed.
- **REST push/pull is per-workspace**: already requires `workspaceId` in request body. No change needed.

Account switching triggers a full page reload (same pattern as existing workspace switcher).

---

## 6. Migration Strategy

### Phase 1: Backend (breaking change)

1. Create new tables (`organizations`, `org_members`, `org_subscriptions`)
2. Add `org_id`, `emoji`, `color` to `workspaces`
3. Run data migration: create personal orgs for existing accounts, set `org_id` on workspaces, migrate subscriptions
4. Update all workspace-related endpoints to use `org_id`
5. Add new org endpoints
6. Update registration flow
7. Rewrite `yjs-sync.js` to use SQLite persistence (workspaceId + noteId in all endpoints)
8. Add `onStoreDocument`/`onLoadDocument` hooks to Hocuspocus
9. Add `yjs-recovery.js` crash recovery job
10. Deploy with version bump (breaking change)

### Phase 2: Frontend

1. Update account store for multi-account
2. Build sidebar with org/workspace sections
3. Add `UserAvatar.vue` component
4. Add workspace emoji/color picker
5. Update `remote-yjs.js` for workspaceId + noteId
6. Update `cloud.js` transport for workspace context
7. Wire up missing features
8. Update all API calls to use new org-scoped endpoints

### Phase 3: Polish

1. Account switcher UI
2. Org management settings
3. Billing settings
4. Audit log viewer
5. i18n for all new strings

---

## 7. Risk & Mitigation

| Risk | Mitigation |
|---|---|
| Breaking change breaks existing users | Version the API; old endpoints return 410 with migration guide |
| Migration misses edge cases | Run migration in a transaction; log all changes; provide manual repair script |
| Multi-account token storage complexity | Store tokens in encrypted local storage; one active session per account |
| Org permission bugs | Extensive test coverage on org membership checks |
| Sidebar performance with many orgs/workspaces | Lazy-load workspace lists per org; virtual scrolling if >50 items |
| Yjs persistence data loss during migration | Recovery job runs on startup; old R2 files preserved as backup |
| Hocuspocus onStoreDocument race condition | Document-level locking during flush; idempotent R2 writes |

---

## 8. Testing

### Backend

- Unit tests for org CRUD, membership, invitation flows
- Integration tests for registration → personal org → default workspace
- Migration tests: verify existing data migrates correctly
- Permission tests: org admin cannot modify other org's workspaces
- Yjs persistence tests: push/pull via SQLite, R2 snapshot on session close
- Recovery job tests: SQLite updates flushed to R2 on startup

### Frontend

- Account switcher: add account, switch, sign out
- Org/workspace navigation: expand/collapse, switch workspace
- Profile image: initials computation, color consistency
- Workspace emoji/color: picker renders, saves, displays in sidebar
- Yjs sync: push/pull with workspaceId + noteId, account switch reloads
- Missing features: workspace delete, export, username update

---

**Ready for review.** Please read the spec and confirm or request changes before I invoke `writing-plans`.
