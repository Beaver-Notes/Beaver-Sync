# Beaver-Sync — Codebase-Wide Refactor Plan

Methodology: `technical-debt-auditor` (inventory + phased roadmap) + `cloud-architect`
(document architectural decisions, no single points of failure) + `obsessive-engineer`
(subtraction, every change correctness-first, tests for the bug each change fixes).

## Prerequisite: a green safety net
A refactor without a trustworthy suite is how you ship silent regressions. The 67
full-suite failures are **not** missing env — `plans-gating` passes alone. They are
cross-file contamination: shared singletons (`models`, the pg pool) and global
monkey-patches (`originalMethods`/`resetStubs` in `commits.test.js`) leak between
files run in one `node --test` process. Phase 0 must make the suite green & isolated
before any strategic refactor lands.

---

## Debt Inventory (categorized)

### Design debt (highest leverage)
| # | Issue | Location | Severity | Effort |
|---|-------|----------|----------|--------|
| D1 | Persistence boundary muddled: Mongoose-style `models` ORM **and** raw `query()`/`transaction()` coexist; 8 route files bypass models | `src/models/index.js` (504 ln) + `commits.js:11, sync-state.js:5, account.js:7, workspaces.js:115, vault.js:7, collaboration.js:6, organizations.js:94, auth.js:122` | High | L |
| D2 | Cross-store non-atomic: Postgres metadata + MinIO object writes not atomic (snapshot create/delete can desync) | `src/routes/sync-state.js`, `src/routes/assets.js` | High | M |
| D3 | Inconsistent `require('../db')`: top-level in some files, inline-in-handler in others (re-evaluates per request) | `auth.js:122, workspaces.js:115, organizations.js:94` | Low | XS |
| D4 | Boolean positional auth param `requireWorkspaceRole(req,reply,id,true/false)` unreadable at call site | `src/routes/yjs-sync.js:66` (4 sites) | Low | S |

### Code debt
| # | Issue | Location | Severity | Effort |
|---|-------|----------|----------|--------|
| C1 | `mapWithConcurrency` extracted to `src/lib/concurrency.js` in prior cleanup — verify all call sites migrated | `src/lib/concurrency.js` | Low | XS |
| C2 | Oversized files (>400 ln): assets 652, collaboration 600, workspaces 586, models 504, auth 498, yjs 465, ws-relay 450 | 7 files | Med | L (per file) |
| C3 | `models/index.js` column names interpolated into SQL (tables allow-listed, columns not) — latent injection footgun | `src/models/index.js:48-133` | Med | S |
| C4 | `findOneAndUpdate`/`findOneAndDelete` do 3 round-trips; `updateMany`/`deleteMany` are exact dupes of `updateOne`/`deleteOne` | `src/models/index.js:359-451` | Low | S |
| C5 | Inconsistent conflict status: `200` idempotent vs `409` sibling paths | `commits.js:171, assets.js:69/354/369, account.js:159/166` | Low | S |
| C6 | `loadUpdatesAfter` stale-check used `COUNT(*)` (fixed → `SELECT 1 LIMIT 1` in 3a2b951) | `src/persistence/yjs.js` | — | done |

### Test debt
| # | Issue | Location | Severity | Effort |
|---|-------|----------|----------|--------|
| T1 | Cross-file state contamination → 67 failures in full run, green in isolation | `test/**` (shared `models`/pool, `commits.test.js` stubs) | High | L |
| T2 | Test helpers copy-pasted across ~15 files; signatures diverge (`seedAccount(plan)` vs `seedAccount(id,kemPublicKey)`) | `test/**` | Med | M |
| T3 | Smoke tests masquerading as coverage (`async.test.js`, `models/async.test.js`) — marked SMOKE in 3a2b951 | done (marked) | — | done |
| T4 | No contract test for ws-relay ↔ api `POST /auth/verify-session` HTTP boundary (optional `x-internal-secret`) | `src/ws-relay.js` ↔ `src/routes/auth.js:284` | Med | M |

### Dependency debt
| # | Package | Risk | Effort |
|---|---------|------|--------|
| P1 | 89 vulns (1 Critical `node-tar` transitive/low-runtime; 53 High `fast-uri` host-confusion) | High | M (bump + retest) |

### Infrastructure / documentation debt
| # | Issue | Impact | Effort |
|---|-------|--------|--------|
| I1 | `deploy.yml` runs `yarn test` with **no Postgres service** → deploy gate permanently red; de-facto gate is PR `ci.yml` only | High | S |
| I2 | ~14 undocumented-but-consumed env vars (incl. `INBOUND_WEBHOOK_SECRET`, `INTERNAL_API_SECRET`) | Med | S |
| I3 | Bus factor = 1; no ADRs; no CONTRIBUTING/onboarding docs | Med | S |

---

## Architecture Decision Records

### ADR-1: Persistence boundary (D1)
**Decision (recommended):** Do **not** rewrite the 504-line ORM. Instead introduce a
thin `src/repositories/` layer: per-domain modules (`accounts.js`, `workspaces.js`,
`notes.js`, `syncState.js`) that own raw SQL and are the *only* place raw `query()`
lives. Route files import repositories instead of `../db` or `models`. Keep `models`
for the simple single-row CRUD it already serves, but stop growing it. This stops
shotgun surgery without a high-risk ORM-vs-SQL rewrite.
**Alternatives considered:** (A) force everything through `models` ORM — high effort,
the ORM is awkward for UNION/multi-row/cursor queries; (B) delete `models`, go all-raw
— large blast radius. Recommendation minimizes diff per change.
**Open question for owner:** confirm "repositories over ORM growth" vs "all-raw".

### ADR-2: Cross-store consistency (D2, cloud-architect "no SPOF")
**Decision (recommended):** Make snapshot/asset lifecycle operations tolerate partial
failure: write Postgres metadata last on create (MinIO object first, then metadata; on
metadata failure, best-effort delete the object); on delete, delete Postgres row then
object, and add a reconciliation sweep (orphan MinIO keys / dangling pg rows) run in a
cron/health route. Document the eventual-consistency contract.
**Alternatives:** two-phase commit / outbox — overkill for this scale.

### ADR-3: Test isolation (T1)
**Decision (recommended):** Each test file gets its own schema namespace or a
`test.after` that truncates its tables; forbid global monkey-patches — use per-test
stub injection or `sinon`/`proxyquire`-style scoped stubs. Add a CI job that runs the
full suite to prove isolation (currently green-in-isolation proves the bug).

---

## Phased Remediation Roadmap

### Phase 0 — Green safety net (BLOCKS everything)
- T1: fix test isolation (scoped stubs + per-file teardown) → full `node --test` green.
- I1: make `deploy.yml` test step use Postgres service (or merge gate into `ci.yml`).
- **Gate:** full suite green & isolated before Phase 1 merges.

### Phase 1 — Quick wins (low effort, high signal)
- P1: bump `node-tar`/`fast-uri` (and `yarn audit` follow-up in `ci.yml` set to fail).
- D3: hoist `require('../db')` to top level (3 files).
- D4: split `requireWorkspaceRole(...,true/false)` → `requireWorkspaceMember`/`requireWorkspaceWriter`.
- I2: document 14 undocumented env vars in `.env.example` (+ add secrets to `validateRequiredEnv`).
- C4/C5: collapse `updateMany`/`deleteMany` dupes; pick one conflict-status convention.

### Phase 2 — Strategic (needs green suite + ADR sign-off)
- ADR-1: build `src/repositories/`; migrate the 8 raw-SQL route files one domain at a time, each behind tests.
- ADR-2: cross-store reconciliation sweep + ordering fix.
- C2: split the 7 oversized files along domain seams; extract shared handlers where duplicated.
- T4: ws-relay ↔ api `verify-session` contract test.
- T2: consolidate `seedAccount`/`seedWorkspace`/`seedOrg`/`makeApp` into `test/helpers/factory.js`.

### Phase 3 — Long-term / organizational
- I3: ADR folder + CONTRIBUTING; reduce bus-factor (document deploy, key rotation).
- C3: column allow-listing in `models` (low priority, not exploitable today).
- Optional: TypeScript migration (high effort, big payoff for AI-maintainability grade).

---

## Effort summary
- Phase 0: M (test isolation is the real work)
- Phase 1: S
- Phase 2: L (incremental per domain)
- Phase 3: S–M

## Recommended first action
Execute Phase 0 first. Begin by confirming T1's contamination mechanism (run full
suite serially; identify the leaking global stub) and fixing it, so every later change
has a real safety net.

---

## Progress Log

- **bee3673** — Phase 1 quick wins: deduped `requireWorkspaceMember`/`requireWorkspaceWriter`
  into `middleware/org.js` (was redefined in `yjs-sync.js`); `models.deleteMany` is now an
  alias of `deleteOne`; test/helpers/db.js teardown makes `beaver_test` hermetic per-file.
  D4 resolved. D3 already resolved in current tree (inline `require('../db')` no longer present).
- **vaultProofChallenge repo** — ADR-1 first step: extracted the `vault_proof_challenges`
  raw SQL (1 INSERT + 1 transaction) out of `vault.js` into
  `src/repositories/vaultProofChallenge.js`. `test/vault.test.js` 6/6 pass. Next domains
  in order of smallness: `organizations.js`, `auth.js`, `workspaces.js`, `commits.js`,
  `collaboration.js`, `account.js`, then `sync-state.js` (largest).
- **syncWorkspaceState repo** — `organizations.js` raw `INSERT INTO sync_workspace_state`
  extracted to `src/repositories/syncWorkspaceState.js` (`createEmptyState`). Confirms
  ADR-1 pattern scales to a table shared with the largest file (`sync-state.js`).
