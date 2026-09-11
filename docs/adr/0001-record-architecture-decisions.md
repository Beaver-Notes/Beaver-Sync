# ADR 0001: Record Architecture Decisions

Date: 2026-08-25 · Status: accepted

We record architecture decisions in this directory as lightweight MADR-style
documents so future contributors know why the system looks the way it does,
not just what it looks like.

## Format

Every ADR uses this template:

```markdown
# ADR NNNN: Title
Date: YYYY-MM-DD · Status: proposed | accepted | superseded by NNNN

## Context
What forces are in play; what problem must be solved.

## Decision
What we decided, stated in active voice.

## Consequences
What becomes easier, what becomes harder, what we accept.
```

One decision per file (`NNNN-title.md`); superseded ADRs are kept, never
edited into revisionism. The first three decisions follow below.

---

# ADR 0002: Postgres is the sole substrate

Date: 2026-08-25 · Status: accepted

## Context

The backend needs relational data (accounts, workspaces, permissions,
billing), object metadata, and a real-time event bus to push sync
notifications between API and WebSocket relay processes. Common deployments
reach for Redis as a second substrate for pub/sub, queues, or rate limiting.
Every additional stateful service on a single-VPS docker compose deployment
is another thing to back up, monitor, secure, and keep consistent with the
database of record.

## Decision

PostgreSQL 16 is the only substrate. All durable state lives there
(`schema.postgres.sql`, no separate migration system). Cross-process sync
fan-out uses Postgres `LISTEN/NOTIFY` on the `sync_notifications` channel:
the ws-relay holds a dedicated client that runs `LISTEN sync_notifications`
and pushes changes into connected rooms. Yjs update dedup relies on a UNIQUE
constraint on `yjs_doc_updates` rather than an application-level lock.

Redis was deliberately not deployed. It was later added — see
`docker-compose.scale.yml` — for exactly one purpose: shared rate-limit
state when running multiple API replicas behind Caddy. It stores nothing
durable (`--save "" --appendonly no`) and its absence or loss never loses
data.

## Consequences

- One backup path (`pg-backup` sidecar), one failure domain, no cache
  invalidation between two sources of truth.
- LISTEN/NOTIFY delivers at-most-once per connection; reconnect logic must
  re-sync room state from tables after relay restarts (accepted).
- If fan-out volume ever outgrows Postgres NOTIFY throughput, revisit with a
  dedicated bus — measured need first.

---

# ADR 0003: Hand-rolled y-websocket-compatible relay instead of Hocuspocus

Date: 2026-08-25 · Status: accepted

## Context

Real-time collaboration needs a WebSocket server speaking the y-websocket
protocol. `@hocuspocus/server` was evaluated and initially used, but its
extension model made three hard requirements awkward: authenticating each
room join against our Fastify session/ticket system, enforcing role-based
read-only access per room, and persisting updates into our own encrypted
schema where the server only ever sees ciphertext.

## Decision

`src/ws-relay.js` implements the y-websocket protocol directly on raw `ws`
+ `y-protocols`. Every connection is authenticated before any document data
flows, via `AUTH_BACKEND_URL` calls to `/auth/verify-session` or the
one-time `/auth/verify-ticket` endpoint, carrying `X-Internal-Secret`
(`INTERNAL_API_SECRET`). Roles come back with the auth response;
`viewer` and `guest` get read-only rooms (relay sends an explicit `auth`
frame with `readOnly: true` and suppresses their writes). Persistence goes
through our own adapter (`src/persistence/yjs.js`) writing encrypted updates
into `yjs_doc_updates`; room names follow `workspace:<id>:note:<id>` and
`workspace:<id>:meta`.

## Consequences

- Full control over per-room authz and persistence; protocol upgrades are
  ours to track against y-protocols releases.
- Rooms live in-memory, so the relay scales to exactly one replica unless
  cross-instance fan-out (e.g. Redis pub/sub) is added later.
- No Hocuspocus dependency surface; fewer transitive deps in the relay image.

---

# ADR 0004: Client-side end-to-end encryption with ML-KEM-768 + AES-256-GCM

Date: 2026-08-25 · Status: accepted

## Context

Beaver Sync is zero-knowledge: notes, attachments, and collaborative edits
must be unreadable to the server operator, the database, and object storage.
Threat model includes harvest-now-decrypt-later adversaries with quantum
capability, so classical-only key exchange is insufficient for long-lived
secrets.

## Decision

All encryption happens client-side. Key encapsulation uses ML-KEM-768
(post-quantum KEM, FIPS 203) seeded from a 64-byte `MLKEM_SEED`
(generated once at first boot, persisted at `MLKEM_SEED_PATH` — losing it
loses decryptability). Payload encryption is AES-256-GCM. The server stores
and relays only ciphertext: note updates carry an `update_encrypted` column,
blobs are encrypted before they reach MinIO/R2, and the relay persists
ciphertext verbatim. Server-side HMAC keys (`NOTE_HMAC_KEY`) exist solely
for identifier blinding, never content decryption.

## Consequences

- Server compromise leaks ciphertext and metadata only; no plaintext search
  or server-side processing is possible (accepted).
- `MLKEM_SEED` becomes the crown jewel secret; rotation is effectively
  re-encryption territory and must not be done casually (see
  docs/key-rotation.md).
- Client libraries must ship ML-KEM implementations; server stays
  crypto-light.
