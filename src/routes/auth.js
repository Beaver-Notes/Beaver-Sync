'use strict';

const crypto = require('crypto');
const { Account, WorkspaceMember } = require('../models');
const { validateSession } = require('../middleware/auth');
const { validatePublicKey } = require('../lib/recipient-wrap');
const { audit } = require('../lib/audit');
const { registerLegacyPasswordRoutes } = require('./auth-password');
const { registerSessionRoutes } = require('./auth-sessions');
const { query } = require('../db');

const AUTH_BODY_LIMIT_BYTES = parseInt(process.env.AUTH_BODY_LIMIT_BYTES ?? '16384', 10);

function timingSafeEqualStr(a, b) {
  const aBuf = Buffer.from(String(a));
  const bBuf = Buffer.from(String(b));
  if (aBuf.length !== bBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

// Shared workspace/note role resolution for verify-session and ws-ticket.
// Returns { role } or { error: { status, payload } }.
async function resolveAuthRole(userId, workspaceId, noteId) {
  if (!workspaceId && !noteId) return {};

  // Workspace-only: require active membership, full stop.
  if (workspaceId && !noteId) {
    const membership = await WorkspaceMember.findOne({ workspaceId, accountId: userId }).lean();
    if (membership) return { role: membership.role };
    return { error: { status: 403, payload: { error: 'forbidden', message: 'Not a member of this workspace.' } } };
  }

  // Note-only (no workspaceId): allow via note collaboration.
  if (!workspaceId && noteId) {
    const { NoteInvitation } = require('../models');
    const collab = await NoteInvitation.findOne({ noteId, userId }).lean();
    if (!collab) {
      return { error: { status: 403, payload: { error: 'forbidden', message: 'Not a collaborator on this note.' } } };
    }
    return { role: collab.role === 'viewer' ? 'viewer' : 'editor' };
  }

  // Both workspaceId and noteId provided (note room):
  // 1. Workspace membership grants access.
  const membership = await WorkspaceMember.findOne({ workspaceId, accountId: userId }).lean();
  if (membership) return { role: membership.role };

  // 2. Not a workspace member — verify note actually belongs to this workspace.
  // Both journal tables, same union as `noteIsServerRegistered`: a note synced
  // only through the Yjs path has rows in `yjs_doc_updates` and none in
  // `sync_document_state`, and checking one table alone refused the ticket,
  // which silently cost the collaborator realtime and presence.
  const { rows } = await query(
    `SELECT 1 FROM sync_document_state WHERE workspace_id = $1 AND note_id = $2
     UNION ALL
     SELECT 1 FROM yjs_doc_updates WHERE workspace_id = $1 AND note_id = $2
     LIMIT 1`,
    [workspaceId, noteId]
  );
  if (rows.length === 0) {
    return { error: { status: 403, payload: { error: 'forbidden', message: 'Note not found in this workspace.' } } };
  }

  // 3. Note belongs to workspace — now check note collaboration.
  const { NoteInvitation } = require('../models');
  const collab = await NoteInvitation.findOne({ noteId, userId }).lean();
  if (!collab) {
    return { error: { status: 403, payload: { error: 'forbidden', message: 'Not a collaborator on this note.' } } };
  }
  return { role: collab.role === 'viewer' ? 'viewer' : 'editor' };
}

async function authRoutes(app) {
  await app.register(require('../middleware/auth'));

  const authRateLimit = {
    config: {
      security: {
        allowedContentTypes: ['application/json'],
        maxContentLength: AUTH_BODY_LIMIT_BYTES,
      },
      rateLimit: {
        max: parseInt(process.env.AUTH_RATE_LIMIT_PER_MINUTE ?? '5', 10),
        timeWindow: '1 minute',
      },
    },
    bodyLimit: AUTH_BODY_LIMIT_BYTES,
  };

  await registerLegacyPasswordRoutes(app, authRateLimit);

  app.post('/keypair', {
    ...authRateLimit,
    preHandler: [app.authenticate],
  }, async (req, reply) => {
    const { kemPublicKey, deviceId } = req.body ?? {};
    if (!kemPublicKey || typeof kemPublicKey !== 'string' || !validatePublicKey(kemPublicKey)) {
      return reply.status(400).send({ error: 'validation_error', message: 'A valid kemPublicKey is required.' });
    }
    const did = typeof deviceId === 'string' && deviceId ? deviceId : 'default';
    const account = await Account.findById(req.userId);
    const keys = Array.isArray(account?.deviceKeys) ? account.deviceKeys : [];
    // Append-only per deviceId: drop any prior entry for this device, then
    // append the new one. Never overwrite the whole array.
    const without = keys.filter((d) => d.deviceId !== did);
    const next = [
      ...without,
      { deviceId: did, publicKey: kemPublicKey, createdAt: new Date().toISOString() },
    ];
    const update = { deviceKeys: JSON.stringify(next) };
    // kemPublicKey stays the legacy primary (first key) so single-key clients
    // keep working; only seed it when not already present.
    if (!account?.kemPublicKey) update.kemPublicKey = kemPublicKey;
    await Account.updateOne({ _id: req.userId }, { $set: update });
    audit(req, 'kem_keypair_updated', { deviceId: did });
    return reply.send({ ok: true, deviceId: did, deviceCount: next.length });
  });

  app.get('/keypair', {
    ...authRateLimit,
    preHandler: [app.authenticate],
  }, async (req, reply) => {
    const targetId = req.query?.userId ? String(req.query.userId) : req.userId;
    const account = await Account.findById(targetId, { kemPublicKey: 1, deviceKeys: 1 }).lean();
    if (!account) return reply.status(404).send({ error: 'not_found', message: 'User not found.' });
    return reply.send({ kemPublicKey: account.kemPublicKey || null, deviceKeys: account.deviceKeys || [] });
  });

  app.post('/verify-session', {
    config: {
      security: {
        public: true,
      },
      rateLimit: {
        max: parseInt(process.env.VERIFY_SESSION_RATE_LIMIT_PER_MINUTE ?? '60', 10),
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    const internalSecret = process.env.INTERNAL_API_SECRET;
    if (!internalSecret) {
      return reply.status(503).send({
        error: 'internal_api_unavailable',
        message: 'Internal API is not configured.',
      });
    }
    const providedSecret = req.headers['x-internal-secret'];
    if (!providedSecret || !timingSafeEqualStr(providedSecret, internalSecret)) {
      return reply.status(403).send({
        error: 'forbidden',
        message: 'Internal API access denied.',
      });
    }

    const { token, workspaceId, noteId } = req.body ?? {};
    if (!token || typeof token !== 'string' || token.length < 32) {
      return reply.status(400).send({
        error: 'invalid_request',
        message: 'Valid session token required.',
      });
    }

    const result = await validateSession(token);
    if (!result) {
      return reply.status(401).send({
        error: 'invalid_token',
        message: 'Session token is invalid or expired.',
      });
    }

    if (workspaceId) {
      if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
        return reply.status(400).send({
          error: 'invalid_request',
          message: 'Invalid workspaceId.',
        });
      }

      const resolved = await resolveAuthRole(result.userId, workspaceId, noteId);
      if (resolved.error) {
        return reply.status(resolved.error.status).send(resolved.error.payload);
      }
      return reply.send({ userId: result.userId, role: resolved.role, deviceId: result.deviceId });
    }

    if (noteId !== undefined) {
      if (typeof noteId !== 'string' || noteId.length === 0) {
        return reply.status(400).send({
          error: 'invalid_request',
          message: 'Invalid noteId.',
        });
      }

      const resolved = await resolveAuthRole(result.userId, undefined, noteId);
      if (resolved.error) {
        return reply.status(resolved.error.status).send(resolved.error.payload);
      }
      return reply.send({ userId: result.userId, role: resolved.role, deviceId: result.deviceId });
    }

    return reply.send({ userId: result.userId, deviceId: result.deviceId });
  });

  // One-time short-lived ticket so session tokens never appear in WS URLs (L-1).
  app.post('/ws-ticket', {
    preHandler: [app.authenticate],
    config: {
      security: { public: false },
      rateLimit: { max: parseInt(process.env.WS_TICKET_RATE_LIMIT_PER_MINUTE ?? '30', 10), timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    const { workspaceId, noteId } = req.body ?? {};
    // A ticket is bound to one room, so the room must be named at mint time.
    // Without this an empty body resolves to no role, the ticket is stored with
    // role NULL, and the relay's `role ?? 'editor'` default grants write access
    // to whatever room the client then puts in the URL.
    if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
      return reply.status(400).send({ error: 'invalid_request', message: 'Valid workspaceId required.' });
    }
    if (noteId !== undefined && (typeof noteId !== 'string' || noteId.length === 0)) {
      return reply.status(400).send({ error: 'invalid_request', message: 'Invalid noteId.' });
    }
    const resolved = await resolveAuthRole(req.userId, workspaceId, noteId);
    if (resolved.error) {
      return reply.status(resolved.error.status).send(resolved.error.payload);
    }
    const ticket = crypto.randomBytes(32).toString('base64url');
    const ttlSeconds = parseInt(process.env.WS_TICKET_TTL_SECONDS ?? '60', 10);
    const { getDb } = require('../db');
    const { hashSessionId } = require('../lib/crypto');
    await getDb().query('DELETE FROM ws_tickets WHERE expires_at < NOW()');
    await getDb().query(
      'INSERT INTO ws_tickets (id_hash, account_id, device_id, role, workspace_id, note_id, expires_at) VALUES ($1,$2,$3,$4,$5,$6, NOW() + make_interval(secs => $7))',
      [hashSessionId(`ws-ticket:${ticket}`), req.userId, req.sessionDeviceId ?? null, resolved.role ?? null, workspaceId, noteId ?? null, ttlSeconds]
    );
    return reply.send({ ticket });
  });

  // Relay-only consumption of ws-tickets. Single-use via atomic DELETE ... RETURNING.
  app.post('/verify-ticket', {
    config: {
      security: { public: true },
      rateLimit: { max: parseInt(process.env.WS_TICKET_RATE_LIMIT_PER_MINUTE ?? '30', 10), timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    const internalSecret = process.env.INTERNAL_API_SECRET;
    if (!internalSecret) {
      return reply.status(503).send({ error: 'internal_api_unavailable', message: 'Internal API is not configured.' });
    }
    const providedSecret = req.headers['x-internal-secret'];
    if (!providedSecret || !timingSafeEqualStr(providedSecret, internalSecret)) {
      return reply.status(403).send({ error: 'forbidden', message: 'Internal API access denied.' });
    }
    const { ticket } = req.body ?? {};
    if (!ticket || typeof ticket !== 'string' || ticket.length < 16) {
      return reply.status(400).send({ error: 'invalid_request', message: 'Valid ticket required.' });
    }
    const { getDb } = require('../db');
    const { hashSessionId } = require('../lib/crypto');
    const consumed = await getDb().query(
      'DELETE FROM ws_tickets WHERE id_hash = $1 AND expires_at > NOW() RETURNING account_id, device_id, role, workspace_id, note_id',
      [hashSessionId(`ws-ticket:${ticket}`)]
    );
    if (consumed.rows.length === 0) {
      return reply.status(401).send({ error: 'invalid_ticket', message: 'Ticket is invalid, used, or expired. Mint a fresh ws-ticket and retry.', retriable: true });
    }
    const row = consumed.rows[0];
    // The room is part of the ticket so the relay can refuse a cross-tenant
    // redemption. Older rows predate the columns; they are refused rather than
    // trusted, since an unbound ticket is exactly what this check exists to stop.
    if (!row.workspace_id) {
      return reply.status(401).send({ error: 'invalid_ticket', message: 'Ticket is invalid, used, or expired. Mint a fresh ws-ticket and retry.', retriable: true });
    }
    const out = { userId: row.account_id, workspaceId: row.workspace_id, noteId: row.note_id ?? null };
    if (row.device_id) out.deviceId = row.device_id;
    if (row.role) out.role = row.role;
    return reply.send(out);
  });

  // 02.2: recovery code → session requiresPasskeyEnroll, consumed-on-use
  app.post('/recover', {
    config: {
      security: { public: true, allowedContentTypes: ['application/json'], maxContentLength: AUTH_BODY_LIMIT_BYTES },
      rateLimit: { max: parseInt(process.env.RECOVERY_RATE_LIMIT_PER_MINUTE ?? '5', 10), timeWindow: '1 minute' },
    },
    bodyLimit: AUTH_BODY_LIMIT_BYTES,
  }, async (req, reply) => {
    const { email, code } = req.body ?? {};
    if (!email || typeof email !== 'string' || !code || typeof code !== 'string') {
      return reply.status(400).send({ error: 'validation_error', message: 'Email and code are required.' });
    }
    const normalized = email.trim().toLowerCase();
    if (!normalized.includes('@')) {
      return reply.status(400).send({ error: 'validation_error', message: 'Invalid email.' });
    }
    if (code.length < 16) {
      return reply.status(400).send({ error: 'validation_error', message: 'Invalid recovery code.' });
    }
    const { createEmailHash, hashRecoveryCode } = require('../lib/crypto');
    const { createSession, setSessionCookieIfAvailable } = require('../middleware/auth');
    const emailHash = createEmailHash(normalized);
    const codeHash = hashRecoveryCode(code);
    // dummy hash ensures constant-time path even when account missing
    const dummyHash = hashRecoveryCode('dummy-recovery-code-not-found-0000000000000000');

    const account = await Account.findOne({ emailHmac: emailHash }).lean();
    const storedHash = account?.recoveryCodeHash || null;
    let isValid;
    if (account && storedHash) {
      try {
        const aBuf = Buffer.from(storedHash, 'hex');
        const bBuf = Buffer.from(codeHash, 'hex');
        isValid = aBuf.length === bBuf.length && crypto.timingSafeEqual(aBuf, bBuf);
      } catch { isValid = false; }
    } else {
      // always do timing-safe compare to avoid enumeration timing leak
      try {
        const aBuf = Buffer.from(dummyHash, 'hex');
        const bBuf = Buffer.from(codeHash, 'hex');
        crypto.timingSafeEqual(aBuf, bBuf);
      } catch {}
      isValid = false;
    }

    if (!isValid) {
      if (account) app.recordSecurityEvent(req, 'recovery_failure', { userId: account.id });
      return reply.status(401).send({ error: 'invalid_recovery_code', message: 'Invalid email or recovery code.' });
    }

    // consumed-on-use: invalidate immediately before issuing session
    await Account.updateOne({ _id: account.id }, { recoveryCodeHash: null, recoveryCodeGeneratedAt: null });

    const rawId = await createSession(account.id, req);
    req.userId = account.id;
    audit(req, 'account_recovered', {});
    setSessionCookieIfAvailable(app, reply, rawId);
    const { createRefreshToken } = require('../middleware/auth');
    const refreshToken = await createRefreshToken(account.id, rawId, req);
    return reply.send({ token: rawId, sessionToken: rawId, refreshToken, requiresPasskeyEnroll: true, message: 'Account recovered. Please enroll a new passkey. This restores ACCOUNT access only; E2E data needs vault passphrase.' });
  });

  await registerSessionRoutes(app);
}

module.exports = authRoutes;
