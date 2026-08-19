# Snapshot Bootstrap for Vault Join — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable new clients joining an existing vault to download initialization snapshots from S3, decrypt them, and apply Yjs state locally — so `pull-batch` incremental sync can work from a populated baseline.

**Architecture:** After vault join (encryption key adoption), the cloud transport detects an empty local workspace and fetches presigned GET URLs for each note's S3 snapshot. Downloads are decrypted using the stored `snapshotTs` as the AAD timestamp, then applied as Yjs updates to populate the local workspace.

**Tech Stack:** Node.js (Fastify, Zod), PostgreSQL, S3/MinIO (presigned URLs), Vue 3 (Composition API), Yjs, Tauri (Rust IPC)

## Global Constraints

- Backend: Node.js/Fastify, PostgreSQL via `query()`/`transaction()` helpers, S3 via `r2` service
- Frontend: Vue 3 + Composition API, Yjs v13.6.31, Tauri desktop
- All sync payloads encrypted with AES-GCM via Rust IPC (`sync_encrypt_batch`/`sync_decrypt_batch`)
- Snapshot encryption format: `encryptJSON({device, ts, seq, noteId, update: Array<number>}, aadSuffix)`
- **AAD suffix must match exactly** what was used during encryption: `${noteId}-${ts}` (per note)
- `ts` is `Date.now()` at encryption time — stored per-document in DB as `snapshot_ts`
- Snapshot S3 key format: `yjs/${workspaceId}/${noteId}/${generation}.yjs` (defined in `sync-state.js:51`)
- Presigned URLs via `r2.presignGet(key, expiresInSeconds)`

## Critical: AAD Timestamp Mismatch

The seed flow encrypts each note with a different `ts`:
- Meta doc: `ts = Date.now()`, AAD = `meta-${ts}`
- Note N: `ts = Date.now() + N`, AAD = `${noteId}-${ts + N}`

The `sync_document_state.checkpoint_ts` is currently always 0. To decrypt downloaded snapshots, the client must know the exact `ts` used during encryption. This requires storing `snapshot_ts` per-document.

---

## File Map

### Backend (Beaver-Sync)

| File | Change |
|------|--------|
| `src/routes/sync-state.js` | Add `snapshot_ts` to CompleteSchema, upsert, readState; add `POST /sync/snapshot-download-urls` endpoint |

### Frontend (Beaver-Notes)

| File | Change |
|------|--------|
| `src/utils/sync/remote-yjs.js` | Add `getSnapshotDownloadUrls()` API function |
| `src/utils/sync/transports/cloud.js` | Add `_bootstrapFromSnapshots()` method; call in `pull()`; pass `snapshotTs` in `_seedCloudOptimized` |

---

## Task 1: Backend — Store `snapshot_ts` per-document + snapshot download endpoint

**Files:**
- Modify: `src/routes/sync-state.js` (CompleteSchema, documentState, upsertSql, readState, new endpoint)

**Interfaces:**
- Consumes: `r2.presignGet()`, `query()`, `transaction()`, `requireWorkspaceMember()`
- Produces: `POST /sync/snapshot-download-urls` → `{ urls: { [noteId]: { url, key } }, generation }`; `GET /sync/state` → includes `snapshotTs` per document

### Step 1: Add `snapshotTs` to CompleteSchema (line 33-38)

Change the document schema to include `snapshotTs`:

```js
  documents: z.array(z.object({
    noteId: z.string().min(1),
    snapshotGeneration: z.number().int().nonnegative(),
    snapshotKey: z.string().min(1),
    checkpointTs: z.number().int().nonnegative().optional().default(0),
    checkpointSequence: z.number().int().nonnegative().optional().default(0),
    snapshotTs: z.number().int().nonnegative().optional().default(0),
  }).strict()).max(5000).superRefine((documents, ctx) => {
```

### Step 2: Add `snapshot_ts` to upsertSql (line 192-205)

Update the INSERT/UPSERT to include the new column:

```js
      const upsertSql = `
        INSERT INTO sync_document_state
          (workspace_id, note_id, snapshot_generation, snapshot_key, checkpoint_ts, checkpoint_sequence, snapshot_ts, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT(workspace_id, note_id) DO UPDATE SET
          snapshot_generation = excluded.snapshot_generation,
          snapshot_key = excluded.snapshot_key,
          checkpoint_ts = excluded.checkpoint_ts,
          checkpoint_sequence = excluded.checkpoint_sequence,
          snapshot_ts = excluded.snapshot_ts,
          updated_at = excluded.updated_at
      `;
      for (const document of documents) {
        await client.query(upsertSql, [workspaceId, document.noteId, document.snapshotGeneration, document.snapshotKey ?? null,
          document.checkpointTs, document.checkpointSequence, document.snapshotTs ?? 0, now]);
      }
```

### Step 3: Add `snapshotTs` to documentState (line 74-82)

Update the response mapper to include the new field:

```js
function documentState(row) {
  return {
    noteId: row.note_id,
    snapshotGeneration: row.snapshot_generation,
    snapshotKey: row.snapshot_key,
    checkpointTs: row.checkpoint_ts,
    checkpointSequence: row.checkpoint_sequence,
    snapshotTs: row.snapshot_ts ?? 0,
  };
}
```

### Step 4: Update the SELECT in readState to include snapshot_ts (line 88-91)

```sql
    SELECT note_id, snapshot_generation, snapshot_key, checkpoint_ts, checkpoint_sequence, snapshot_ts
    FROM sync_document_state WHERE workspace_id = $1 ORDER BY note_id
```

### Step 5: Add `POST /sync/snapshot-download-urls` endpoint

Add before the closing `});` of `syncStateRoutes`:

```js
  app.post('/snapshot-download-urls', protect, async (req, reply) => {
    const parsed = z.object({
      workspaceId: z.string().min(1),
      noteIds: z.array(z.string().min(1).max(256)).min(1).max(500),
    }).strict().safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'validation_error' });
    const { workspaceId, noteIds } = parsed.data;
    await requireWorkspaceMember(req, reply, workspaceId);
    if (reply.sent) return;

    const storage = getObjectStorage();
    if (!storage || typeof storage.presignGet !== 'function') {
      return reply.status(503).send({ error: 'storage_unavailable' });
    }

    const { rows } = await query(`
      SELECT note_id, snapshot_generation, snapshot_key, snapshot_ts
      FROM sync_document_state
      WHERE workspace_id = $1 AND note_id = ANY($2)
        AND snapshot_key IS NOT NULL AND snapshot_key != ''
    `, [workspaceId, noteIds]);

    const generation = rows[0]?.snapshot_generation ?? 0;
    const urls = {};
    const presignPromises = [];
    const noteIdsToSign = [];

    for (const row of rows) {
      noteIdsToSign.push(row.note_id);
      presignPromises.push(storage.presignGet(row.snapshot_key, 600));
    }

    const presignedUrls = await Promise.all(presignPromises);
    for (let i = 0; i < noteIdsToSign.length; i++) {
      const row = rows.find(r => r.note_id === noteIdsToSign[i]);
      urls[noteIdsToSign[i]] = {
        url: presignedUrls[i],
        key: row.snapshot_key,
        snapshotTs: row.snapshot_ts ?? 0,
      };
    }

    return reply.send({ urls, generation });
  });
```

### Step 6: Run the DB migration

```bash
docker exec beaver-sync-test-postgres psql -U beaver -d beaver -c \
  "ALTER TABLE sync_document_state ADD COLUMN IF NOT EXISTS snapshot_ts bigint NOT NULL DEFAULT 0;"
```

### Step 7: Rebuild Docker and verify

```bash
cd /Users/danielerolli/Documents/GitHub/Beaver-Sync
docker compose build api && docker compose up -d api
```

Verify with curl:

```bash
# The endpoint should return URLs with snapshotTs
curl -s http://localhost:3000/sync/snapshot-download-urls \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"workspaceId":"57c4f7d5-ad4a-4276-a37a-f069a9612a3a","noteIds":["meta"]}' | jq .
```

Expected: Returns `{ "urls": { "meta": { "url": "...", "key": "yjs/...", "snapshotTs": <timestamp> } }, "generation": 1 }`

### Step 8: Commit

```bash
git add src/routes/sync-state.js
git commit -m "feat: store snapshot_ts per-document and add snapshot-download-urls endpoint"
```

---

## Task 2: Frontend — Add `getSnapshotDownloadUrls` API function

**Files:**
- Modify: `src/utils/sync/remote-yjs.js:194` (add after `getSnapshotUrls`)

**Interfaces:**
- Consumes: `getClient()` (API client)
- Produces: `getSnapshotDownloadUrls(workspaceId, noteIds)` → `{ urls: { [noteId]: { url, key, snapshotTs } }, generation }`

### Step 1: Add the function

Add after `getSnapshotUrls` (line 194):

```js
export async function getSnapshotDownloadUrls(workspaceId, noteIds) {
  return getClient().post('/sync/snapshot-download-urls', {
    workspaceId,
    noteIds,
  }, { timeoutMs: 30000 });
}
```

### Step 2: Commit

```bash
git add src/utils/sync/remote-yjs.js
git commit -m "feat: add getSnapshotDownloadUrls API function"
```

---

## Task 3: Frontend — Pass `snapshotTs` during seed + Add bootstrap logic

**Files:**
- Modify: `src/utils/sync/transports/cloud.js:1-11` (add import)
- Modify: `src/utils/sync/transports/cloud.js:862-868` (pass snapshotTs in seed)
- Modify: `src/utils/sync/transports/cloud.js:244` (add bootstrap check after getRemoteState)

**Interfaces:**
- Consumes: `getSnapshotDownloadUrls()` from remote-yjs.js, `decryptBatch()` from crypto.js, `appendUpdate()` from yjs.js
- Produces: Populated local Yjs workspace so `pull-batch` and normal sync work

### Step 1: Add import

Add `getSnapshotDownloadUrls` to the existing import from `../remote-yjs.js` on line 4-11:

```js
import {
  pushUpdates as remotePushUpdates,
  pullUpdates as remotePullUpdates,
  getRemoteState,
  claimInitialization,
  completeInitialization,
  getSnapshotUrls,
  createWorkspace,
  getSnapshotDownloadUrls,
} from '../remote-yjs.js';
```

### Step 2: Pass `snapshotTs` during seed (line 862-868)

Change the document push to include the `ts` used for encryption:

```js
        documents.push({
          noteId,
          snapshotGeneration: generation,
          snapshotKey: key,
          checkpointTs: 0,
          checkpointSequence: 0,
          snapshotTs: noteTs,
        });
```

### Step 3: Add `_bootstrapFromSnapshots` method

Add this method to the `CloudTransport` class (after `_ensureWorkspace`, around line 212):

```js
  async _bootstrapFromSnapshots(state) {
    const workspaceId = await this._ensureWorkspace();
    if (!workspaceId) return false;

    const docs = (state.documents || []).filter(
      (d) => d.snapshotKey && d.noteId
    );
    if (docs.length === 0) return false;

    const { getSnapshots } = await import('@/lib/native/yjs.js');
    const allNoteIds = docs.map((d) => d.noteId);
    const localSnapshots = await getSnapshots(allNoteIds).catch(() => ({}));
    const needsBootstrap = docs.filter(
      (d) => !localSnapshots?.[d.noteId] || localSnapshots[d.noteId].length === 0
    );

    if (needsBootstrap.length === 0) return false;
    logger.info(`[sync] bootstrap: ${needsBootstrap.length} notes need snapshot download`);

    const noteIdsForDownload = needsBootstrap.map((d) => d.noteId);
    const BATCH_SIZE = 50;
    const allUrls = {};
    let generation = 0;

    for (let i = 0; i < noteIdsForDownload.length; i += BATCH_SIZE) {
      const batch = noteIdsForDownload.slice(i, i + BATCH_SIZE);
      try {
        const result = await getSnapshotDownloadUrls(workspaceId, batch);
        if (result?.urls) Object.assign(allUrls, result.urls);
        if (result?.generation) generation = result.generation;
      } catch (err) {
        console.warn('[sync] bootstrap: failed to get download URLs:', err?.message);
        return false;
      }
    }

    const urlEntries = Object.entries(allUrls);
    if (urlEntries.length === 0) {
      logger.info('[sync] bootstrap: no snapshot URLs returned');
      return false;
    }

    const { decryptBatch } = await import('../crypto.js');
    const downloadedItems = [];

    for (const [noteId, { url, snapshotTs }] of urlEntries) {
      try {
        const response = await fetch(url);
        if (!response.ok) {
          console.warn(`[sync] bootstrap: download failed for ${noteId}: ${response.status}`);
          continue;
        }
        const blob = await response.blob();
        const arrayBuf = await blob.arrayBuffer();
        const b64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuf)));
        downloadedItems.push({ _noteId: noteId, data: b64, key: `bootstrap-${noteId}`, snapshotTs });
      } catch (err) {
        console.warn(`[sync] bootstrap: download error for ${noteId}:`, err?.message);
      }
    }

    if (downloadedItems.length === 0) {
      logger.info('[sync] bootstrap: no snapshots downloaded');
      return false;
    }

    // Build AAD suffixes using the stored snapshotTs from each item
    const aadSuffixes = downloadedItems.map(
      (item) => `${item._noteId}-${item.snapshotTs}`
    );

    const decrypted = await decryptBatch(
      downloadedItems.map((item) => item.data),
      aadSuffixes
    );
    const { appendUpdate } = await import('@/lib/native/yjs.js');
    let applied = 0;

    for (let i = 0; i < decrypted.length; i++) {
      const item = decrypted[i];
      if (!item?.update) continue;
      try {
        const noteId = downloadedItems[i]._noteId;
        const updateBytes = item.update instanceof Uint8Array
          ? item.update
          : new Uint8Array(item.update);

        await appendUpdate(noteId, updateBytes, getSyncDeviceId());
        applied++;
      } catch (err) {
        console.warn(`[sync] bootstrap: apply failed for ${downloadedItems[i]?._noteId}:`, err?.message);
      }
    }

    logger.info(`[sync] bootstrap: applied ${applied}/${downloadedItems.length} snapshots`);
    return applied > 0;
  }
```

### Step 4: Call bootstrap in `pull()` after `getRemoteState`

Modify the `pull()` method. After the `getRemoteState` call succeeds (after line 243), add:

```js
    // Bootstrap from server snapshots if local workspace is empty
    try {
      const bootstrapped = await this._bootstrapFromSnapshots(state);
      if (bootstrapped) {
        logger.info('[sync] bootstrap complete — re-fetching remote state');
        state = await getRemoteState(workspaceId);
      }
    } catch (err) {
      console.warn('[sync] bootstrap failed (continuing with pull):', err?.message);
    }
```

### Step 5: Test end-to-end

1. Run DB migration: `docker exec beaver-sync-test-postgres psql -U beaver -d beaver -c "ALTER TABLE sync_document_state ADD COLUMN IF NOT EXISTS snapshot_ts bigint NOT NULL DEFAULT 0;"`
2. Update existing rows: `docker exec beaver-sync-test-postgres psql -U beaver -d beaver -c "UPDATE sync_document_state SET snapshot_ts = 0 WHERE snapshot_ts = 0;"`
3. Rebuild backend: `cd /Users/danielerolli/Documents/GitHub/Beaver-Sync && docker compose build api && docker compose up -d`
4. Rebuild frontend: `cd /Users/danielerolli/Documents/GitHub/Beaver-Notes && npm run tauri build` (or dev)
5. Log in and import workspace (vault join)
6. Check DevTools console for:
   - `[sync] bootstrap: X notes need snapshot download`
   - `[sync] bootstrap: applied X/Y snapshots`
   - `cloud pull got X updates`
7. Verify notes appear in the UI

### Step 6: Commit

```bash
git add src/utils/sync/remote-yjs.js src/utils/sync/transports/cloud.js
git commit -m "feat: bootstrap from server snapshots on vault join"
```

---

## Verification Checklist

- [ ] `POST /sync/snapshot-download-urls` returns presigned GET URLs with `snapshotTs` per document
- [ ] Endpoint rejects unauthenticated requests (401)
- [ ] Endpoint rejects non-workspace-members (403)
- [ ] Endpoint returns empty `urls` for notes without snapshots
- [ ] `GET /sync/state` returns `snapshotTs` per document
- [ ] Frontend `getSnapshotDownloadUrls()` calls the endpoint correctly
- [ ] `_bootstrapFromSnapshots` detects notes with no local data
- [ ] AAD suffixes use stored `snapshotTs` for correct decryption
- [ ] Applied Yjs updates populate the local workspace
- [ ] Subsequent `pull-batch` cycles get incremental updates
- [ ] Notes appear in the UI after bootstrap
- [ ] Bootstrap is idempotent (running again doesn't break anything)
- [ ] Console logs show clear trace: bootstrap start → download → decrypt → apply → pull
