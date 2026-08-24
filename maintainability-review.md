# Maintainability Review — Beaver Sync

**Date:** 2026-08-24
**Stack detected:** Node.js 22, Fastify 4, `pg` (Postgres), Yjs (CRDT sync), MinIO/R2 object storage, separate `ws-relay` process. Plain JavaScript — **no TypeScript**, ESLint is the only static gate.
**Deploy context:** prod (Fly.io via `fly/` + `docker-compose.prod.yml`; `deploy.yml` runs `flyctl deploy`).
**Release model calibrated against:** deploy is triggered by **push to `main`** → `deploy.yml` runs `yarn test` (no Postgres service) then `flyctl deploy`; a **PR → `main`** `ci.yml` run does `yarn lint` + `yarn test` **with a Postgres:16 service** (`beaver_test`). Because (a) the deploy test step has no DB and (b) the suite is permanently red (see §3/§10), the deploy gate's own test is non-functional. The **de-facto gate before the prod artifact is the PR `ci.yml` run** — and only if branch protection requires it.

---

## 2. Grades

| Axis | Grade | Score | Why |
|------|-------|-------|-----|
| **AI-maintainability** | C | 5.5 / 10 | Excellent greppability and a clear entry point (`src/server.js`), but an **agent can never get a green test signal** (permanently-red suite) and there is **no type-check**, so an agent's changes are not reliably caught before they ship. |
| **Human-maintainability** | C | 5.0 / 10 | Held back by **bus factor = 1** and onboarding friction (duplicated test helpers with divergent signatures, dual persistence boundary). Recoverable (Apache-2.0, committed lockfiles, Dockerfile), so loss is survivable but disruptive. |

**Why they diverge:** Both are dragged down by the same permanently-red suite, but for *different* reasons. The AI score is limited mainly by **feedback-loop quality** (no green/red signal, no types) — an agent navigates the code fine but can't verify. The human score is limited mainly by **bus-factor and context transfer** (one author, duplicated helpers, two competing data-access styles) — a human can verify via running tests but struggles to safely change anything. Navigability is the AI's strength and the human's lesser concern.

---

## 3. Measured spine (lead with this)

| Dimension | Finding | Status |
|-----------|---------|--------|
| **Gate reality** | PR `ci.yml` = real (Postgres+lint+test). `deploy.yml` test step = **no DB + permanently-red suite** → non-functional. | ⚠️ Red / broken |
| **Test execution** | `node --test --test-concurrency=1`, needs Postgres + MinIO. Full run = **67 failures**, and 1 is a **hard-coded broken test** (`schema.test.js:69`) that can never pass. | 🔴 Red |
| **Lint** | `eslint src/` (`yarn lint`) — runs and passes on changed files. | 🟢 Works |
| **Type-check** | None — plain JS. ESLint only. | ⚪ N/A |
| **Worst dependency vuln** | `node-tar` **Critical** (transitive DoS) + **53 High** (e.g. `fast-uri` host-confusion). 89 total (1 Crit / 53 High / 26 Mod / 9 Low). | 🔴 89 vulns |
| **Oversized files** | **7 of ~64 src files > 400 lines**: assets.js (652), collaboration.js (600), workspaces.js (586), models/index.js (504), auth.js (498), persistence/yjs.js (465), ws-relay.js (450). | ⚠️ 11% |
| **Bus factor** | **1** — sole author ("Daniele-rolli" / "Daniele Rolli" are the same person, two git identities). | 🔴 1 |

**Plain statement:** the deployed artifact is **not reliably gated by green tests**. The deploy workflow's test step cannot pass as written, and even the PR gate's suite is permanently red due to a stale test. No type-check exists to catch contract/shape regressions.

---

## 4. Static checks & dependency table

| Check | Command | Gates deploy? | Notes |
|-------|---------|---------------|-------|
| Lint | `yarn lint` (`eslint src/`) | Yes (ci + deploy) | Style/config only; catches nothing semantic. |
| Test | `yarn test` (`node --test`) | Yes (ci + deploy) | **Permanently red** — see §3/§10. Effectively not a trusted gate. |
| Type-check | — | No | JS only. |
| `yarn audit` | `yarn audit` | No | 89 vulns; not wired into CI. |

| Dependency risk | Package | Severity | Reachable at runtime? |
|-----------------|---------|----------|----------------------|
| Transitive DoS | `node-tar` | **Critical** | No — not a direct dep, app has no tar-extraction feature. Low real risk; still patch. |
| Host confusion | `fast-uri` (via fastify > ajv) | High | Indirect; low exploitability but should be bumped. |
| Other | 51 more High | High | Not individually triaged this pass. |

---

## 5. Ranked enforcement gaps

1. **Suite can never be green (broken meta-test).** `test/db/schema.test.js:69` asserts `src/db/migrations/*.postgres.sql` exists; it does not (migrations are `src/db/migrate-postgres.js` + `src/db/schema.postgres.sql`). Until fixed, **every** gate that runs `yarn test` is red by construction. *Risk: high, Effort: low, Leverage: highest.*
2. **Deploy gate has no DB.** `deploy.yml` runs `yarn test` without a Postgres service → cannot pass. *Risk: high, Effort: low.*
3. **No branch protection / CI-status requirement verified.** If `main` can be pushed directly, broken tests ship. *Risk: high, Effort: low.*
4. **No type-check / contract tests.** Shape regressions (e.g. ws-relay↔api, sync protocol) ship silently. *Risk: med, Effort: med.*
5. **Dependency vulns not gated.** `yarn audit` not in CI; 89 vulns accumulate. *Risk: med, Effort: low.*
6. **`yarn audit` not enforced** — see above.

*Not worth fixing now (solo, low consequence):* per-file `const protect` duplication (fine pattern); `ASSET_KEY_PATTERN`/`validKeySegment` centralization (cosmetic).

---

## 6. Cross-boundary contract drift

| Boundary | Enforcement | Score (1–5) | Concrete hazards |
|----------|-------------|-------------|------------------|
| **ws-relay ↔ API** (`POST /auth/verify-session`, `src/ws-relay.js:130` ↔ `src/routes/auth.js:284`) | None — HTTP JSON, no shared types. Optional `x-internal-secret` coupling. | **2** | (1) API response shape change breaks relay silently. (2) If `INTERNAL_API_SECRET` is set on API but not sent by relay, every socket is 403'd. (3) Relay default `AUTH_BACKEND_URL=https://beaver-sync.internal:3000` diverges from deployed host. |
| **API ↔ Yjs clients** (external web/mobile) | None — field shapes (`update_data`, `device_id`, `clock`, `ts`) live only in `persistence/yjs.js`, not shared. | **2** | (1) Client/server add a field → silent deserialize miss. (2) `MAX_UPDATES_PER_PULL` / checkpoint format drift. (3) No generated client or schema. |
| **API ↔ MinIO/R2** (object keys) | Partial — `validKeySegment` / `ASSET_KEY_PATTERN` enforce key *format*, but producer (API presign) and consumer (client PUT) must agree on the *scheme*. | **3** | (1) Snapshot key scheme change breaks replay. (2) `verifyObject` swallows non-404 errors (fixed this session) masked outages. |
| **Postgres ↔ MinIO** (snapshot metadata vs blob) | None — written non-atomically (presign PUT, then `/snapshot-complete` writes `sync_document_state`). | **2** | (1) MinIO PUT succeeds, complete fails → orphan blob + missing metadata. (2) Metadata present, blob missing → `verifyObject` 404. No outbox/saga. |

**Cheapest fix per boundary:** add a contract test for `/auth/verify-session` (ws-relay↔api); extract the Yjs sync shape into a shared module imported by both server and (future) client; add a periodic Postgres↔MinIO consistency check.

---

## 7. Data model findings

Single Postgres store (`src/db/schema.postgres.sql` + JS migration runner `migrate-postgres.js`) **plus** MinIO/R2 object storage. Schema is **actively evolving** (migration runner present, recent commits touch it). No dead/deprecated entities spotted in the model layer. **Cross-store seam (the real risk):** snapshot/asset *metadata* in Postgres references *blobs* in MinIO by key, written in two non-atomic steps — a silent-breakage seam for both human and LLM editors (see §6, last row).

---

## 8. Bus factor & knowledge risk

- **Bus factor = 1** (single author, two git identities). 
- **Recoverability:** good — **Apache-2.0** license, **both `yarn.lock` and `package-lock.json` committed**, `Dockerfile` + `docker-compose` present → fully forkable and reproducible.
- **Consequence-of-loss:** unknown externally, but this is a shipped sync product ("Beaver Sync") implying users depend on it. A bus-factor 1 on a product *with* external users is a real risk; the Apache-2.0 + reproducible-build posture caps the *severity* (anyone can fork), not the *likelihood* of stagnation.
- **Net:** moderate human risk — survivable but disruptive; the dual persistence boundary and duplicated test helpers concentrate knowledge in the sole author's head.

---

## 9. Duplication worth collapsing

- **Persistence boundary split (highest leverage):** `src/models/index.js` (504-line Mongoose-like ORM) coexists with raw `query()`/`transaction()` SQL in **8 route files** (commits, sync-state, account, workspaces, vault, collaboration, organizations, auth). `account.js` uses both styles. → shotgun surgery on schema change.
- **Test helpers (signature drift):** `makeApp` / `seedAccount` / `seedOrg` / `seedWorkspace` copy-pasted across **~15 test files with divergent signatures** (e.g. `seedAccount(plan)` vs `seedAccount(id, kemPublicKey)`). → consolidating into `test/helpers/factory.js` would remove a class of silent breakage.
- **`const protect` / `protectWrite` guards** redeclared in 15 route files — acceptable pattern, low priority.
- **`ASSET_KEY_PATTERN` / `validKeySegment`** not yet centralized (cosmetic).
- `updateMany`/`deleteMany` duplication claimed in an earlier audit **could not be confirmed** (`grep` found no such functions) — not asserted here.

---

## 10. Critic-driven investigations

**Confirmed findings (highest-stakes):**
1. **Suite is permanently red by construction.** `test/db/schema.test.js:69` reads `src/db/migrations` (does not exist) expecting `*.postgres.sql`; real migrations are `src/db/migrate-postgres.js` + `src/db/schema.postgres.sql`. Test throws → always fails. *Evidence: read test + `ls src/db/`.* This alone breaks every test gate.
2. **`node-tar` Critical is low real risk.** Not a direct dependency; app performs no tar extraction. *Evidence: `grep` of `package.json` + `yarn why`.*
3. **Postgres↔MinIO write is non-atomic.** Presign PUT then `/snapshot-complete` updates Postgres; no transaction across stores. *Evidence: `r2.js` `verifyObject` + sync-state snapshot endpoints.*
4. **ws-relay↔api contract is unenforced.** HTTP JSON, optional `x-internal-secret` coupling, default URL mismatch. *Evidence: read both `ws-relay.js` and `auth.js:284`.*
5. **Project is recoverable/forkable.** Apache-2.0 + committed lockfiles + Dockerfile. *Evidence: `LICENSE`, `ls`.*

**Still unmeasured (guess at grade impact):**
- **External consequence-of-loss** (real user base size) — could move human grade ±1.
- **Individual reachability of the 53 High vulns** — could move dependency grade.
- **Runtime performance under load** (N+1s identified earlier in `readState` UNION, `assets GET /`) — not load-tested this pass.
- **Branch-protection setting** on `main` — if absent, deploy gate is moot; high impact on gate reality.
- **Secret hygiene** beyond known (`INTERNAL_API_SECRET`, `INBOUND_WEBHOOK_SECRET`) — not audited.

---

## 11. Action list (highest-leverage first, de-duplicated)

1. **Fix the broken migration meta-test** (`test/db/schema.test.js:69`) and the `postgres-ha` "can run migrations" test so the suite *can* be green. *(HIGH leverage, LOW effort)* — without this, no gate is trustworthy.
2. **Add a Postgres service to `deploy.yml`'s test step** (or reuse `ci.yml`) so the deploy gate actually runs tests. *(HIGH, LOW)*
3. **Require `ci.yml` status via branch protection** on `main`. *(HIGH, LOW)*
4. **Wire `yarn audit` into CI** (fail on High/Critical) and bump `node-tar`/`fast-uri`. *(MED, LOW)*
5. **Collapse the persistence boundary** — route the 8 raw-SQL route files through `models/` or a `repositories/` layer (pick one). *(MED/HIGH effort, HIGH leverage)*
6. **Consolidate test helpers** into `test/helpers/factory.js` with one signature. *(MED)*
7. **Split the 7 oversized files** (assets 652, collaboration 600, workspaces 586, …) into focused modules. *(MED)*
8. **Add a contract test** for `/auth/verify-session` (ws-relay↔api) and extract the Yjs sync shape into a shared module. *(LOW/MED)*
9. **Add a Postgres↔MinIO consistency check** for snapshot/asset keys. *(LOW unless failures observed)*
10. **Make no-assertion smoke tests** (`test/routes/async.test.js`, `test/models/async.test.js`) assert behavior or mark clearly as smoke. *(LOW)*

*Out of scope (solo, low consequence):* `const protect` per-file duplication; `ASSET_KEY_PATTERN`/`validKeySegment` centralization.
