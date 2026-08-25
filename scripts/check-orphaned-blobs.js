#!/usr/bin/env node
"use strict";

/**
 * scripts/check-orphaned-blobs.js
 *
 * READ-ONLY consistency check between MinIO blobs and Postgres metadata.
 * Detects two directions of drift; never mutates anything.
 *
 * DB row -> blob key mapping (see src/services/r2.js):
 *   commits(account_id, commit_id)     -> <account_id>/commits/<commit_id>.json
 *   sync_document_state.snapshot_key   -> literal key (yjs/<ws>/<note>/<gen>.yjs)
 *
 * assets/<key>, <uid>/snapshot.json and <uid>/export-*.zip have no database
 * rows by design (assets are listed straight from storage), so they are
 * reported as "untracked by design" instead of false orphans.
 *
 * Usage:
 *   DATABASE_URL=postgresql://beaver:beaver@localhost:5432/beaver \
 *   STORAGE_ENDPOINT=http://localhost:9000 node scripts/check-orphaned-blobs.js
 */

// Must precede requires: r2.js resolves its config at load time.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://beaver:beaver@localhost:5432/beaver";
// Host-run default; inside Docker the r2.js default (http://minio:9000) applies.
process.env.STORAGE_ENDPOINT =
  process.env.STORAGE_ENDPOINT || "http://localhost:9000";

const { Client } = require("pg");
const r2 = require("../src/services/r2");

const SAMPLE_LIMIT = 20;
const sample = (arr) => arr.slice(0, SAMPLE_LIMIT);

async function main() {
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();

  const accounts = new Set(
    (await pg.query("SELECT id FROM accounts")).rows.map((r) => r.id),
  );
  const commitRows = (
    await pg.query("SELECT account_id, commit_id FROM commits")
  ).rows;
  const yjsKeys = new Set(
    (
      await pg.query(
        `SELECT snapshot_key FROM sync_document_state
         WHERE snapshot_key IS NOT NULL AND snapshot_key != ''`,
      )
    ).rows.map((r) => r.snapshot_key),
  );
  await pg.end();

  const commitKeys = new Set(
    commitRows.map((r) => r2.commitKey(r.account_id, r.commit_id)),
  );
  const blobs = new Set(await r2.listKeys());

  // Direction A: blobs with no DB backing.
  const orphans = [];
  let untrackedByDesign = 0;
  for (const key of blobs) {
    if (commitKeys.has(key) || yjsKeys.has(key)) continue;

    const slash = key.indexOf("/");
    const uid = slash === -1 ? null : key.slice(0, slash);
    const rest = slash === -1 ? "" : key.slice(slash + 1);

    // No owning account, or known namespaces whose DB row is missing,
    // or an unrecognized layout -> treat as orphan.
    const untrackedNamespace =
      uid &&
      accounts.has(uid) &&
      (rest.startsWith("assets/") ||
        rest === "snapshot.json" ||
        /^export-[0-9a-f-]+\.zip$/.test(rest));

    if (untrackedNamespace) {
      untrackedByDesign++;
    } else {
      orphans.push(key);
    }
  }

  // Direction B: DB rows whose blob is gone.
  const danglingCommits = commitRows
    .map((r) => r2.commitKey(r.account_id, r.commit_id))
    .filter((k) => !blobs.has(k));
  const danglingSnapshots = [...yjsKeys].filter((k) => !blobs.has(k));

  console.log(`Bucket: ${r2.storageConfig.bucket} @ ${r2.storageConfig.endpoint}`);
  console.log(
    `MinIO objects: ${blobs.size} | accounts: ${accounts.size} | commit rows: ${commitRows.length} | yjs snapshot rows: ${yjsKeys.size}`,
  );

  console.log(`\nOrphaned blobs (no DB backing): ${orphans.length}`);
  for (const k of sample(orphans)) console.log(`  - ${k}`);
  if (orphans.length > SAMPLE_LIMIT) console.log(`  ... and ${orphans.length - SAMPLE_LIMIT} more`);

  console.log(`\nUntracked-by-design blobs (assets/, snapshot.json, export zips): ${untrackedByDesign}`);

  console.log(`\nDangling DB rows (blob missing): ${danglingCommits.length + danglingSnapshots.length}`);
  console.log(`  dangling commits: ${danglingCommits.length}`);
  for (const k of sample(danglingCommits)) console.log(`    - ${k}`);
  if (danglingCommits.length > SAMPLE_LIMIT)
    console.log(`    ... and ${danglingCommits.length - SAMPLE_LIMIT} more`);
  console.log(`  dangling yjs snapshots: ${danglingSnapshots.length}`);
  for (const k of sample(danglingSnapshots)) console.log(`    - ${k}`);
  if (danglingSnapshots.length > SAMPLE_LIMIT)
    console.log(`    ... and ${danglingSnapshots.length - SAMPLE_LIMIT} more`);
}

main()
  .then(() => {
    // Report-only: findings never affect exit code.
    process.exit(0);
  })
  .catch((err) => {
    console.error("check failed:", err.message);
    process.exit(1);
  });
