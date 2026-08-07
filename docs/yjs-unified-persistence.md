# Yjs + Hocuspocus Unified Persistence — Implementation Summary

## Problem

Two disconnected persistence paths for Yjs data:

1. **Hocuspocus (WebSocket)** → SQLite (`yjs_doc_updates` table)
2. **REST API (`/yjs/push`, `/yjs/pull`)** → Cloudflare R2 (individual files)

These paths don't share state. A user editing via WebSocket can't be seen by a device syncing via REST. Every Yjs update was an individual R2 PUT ($5/M writes).

## Solution

Unified persistence: SQLite is the single source of truth for all Yjs updates. R2 holds full document snapshots as a durable backup, written only on session close (1 PUT per document, not per update).

---

## Changes

### Backend (Beaver-Sync)

#### `src/hocuspocus.js`

- **Removed** dead `POST /workspaces/is-member` fetch. The `/auth/verify-session` endpoint already validates workspace membership when `workspaceId` is provided (returns the role). The second call was broken (endpoint doesn't exist, returns 404, Hocuspocus only checks for 403 so it silently passed).

- **Added `onStoreDocument` hook** (via `configuration.extensions`). When all clients disconnect from a document:
  1. Serializes full Y.Doc state via `document.toBinary()`
  2. Writes to R2 at `yjs/{workspaceId}/{noteId}.yjs` (1 PUT)
  3. Clears incremental updates from SQLite

- **Updated `onLoadDocument`** to check R2 first:
  1. Try loading full snapshot from R2
  2. If found, apply it and return (fast path)
  3. If not found, fall back to incremental updates from SQLite

- **Wired recovery job** on startup to flush any SQLite updates that didn't make it to R2 before a crash.

#### `src/routes/yjs-sync.js` (full rewrite)

**Breaking change:** All endpoints now require `workspaceId` and `noteId` in the request body.

- `POST /yjs/push` — Schema: `{ workspaceId, noteId, updates: [{key, data}] }`
  - Writes to SQLite via `persistence.storeUpdate()` instead of R2
  - Parses filename to extract timestamp for the `ts` field
  - Still updates storage quota on Workspace/Subscription model

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

### Frontend (Beaver-Notes)

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

- Imports `useWorkspaceStore` from Pinia
- `_getWorkspaceId()` — returns `workspaceStore.activeId`
- `pull()` — gets workspaceId, groups cursor keys by noteId (format `{noteId}:{deviceId}`), makes per-note pull requests
- `push()` — gets workspaceId, groups files by noteId (parsed from sync filename), makes per-note push requests

---

## Data Flow (After)

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

## Cost Impact

| Operation | Before | After |
|-----------|--------|-------|
| R2 PUTs per Yjs session | N (one per update) | 1 (full doc on close) |
| R2 reads per pull | N (listKeys + get per key) | 0 (SQLite) |
| R2 reads per push | N (one per update) | 0 (SQLite) |
| SQLite writes per update | 1 (Hocuspocus only) | 1 (unified) |
| Crash data loss risk | High (R2 not written) | Low (SQLite durable + recovery) |

**Estimated R2 operation reduction: ~95%**

## Migration Notes

- This is a **breaking change** to the `/yjs/push`, `/yjs/pull`, and `/yjs/updates` endpoints
- Old R2-stored Yjs files (`<userId>/yjs/<filename>`) will not be accessible via the new pull endpoint
- Existing data in SQLite via Hocuspocus is preserved and accessible
- The R2 flush mechanism will create new snapshots at `yjs/{workspaceId}/{noteId}.yjs` on session close
- The recovery job handles any SQLite updates that didn't flush before a crash
