'use strict';

const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { z } = require('zod');
const { VaultKeyParams, WorkspaceMember } = require('../models');
const { query, transaction } = require('../db');
const { audit } = require('../lib/audit');

const BCRYPT_ROUNDS = 12;
const PROOF_VERSION = 1;
const CHALLENGE_TTL_MS = 60 * 1000;

const BODY_LIMIT = parseInt(process.env.VAULT_BODY_LIMIT_BYTES ?? '65536', 10);

const PublishSchema = z.object({
  keyParams: z.string().min(1),
  passphraseProof: z.string().min(1).max(1024),
  challenge: z.string().min(1).max(256),
}).strict();

const VerifySchema = z.object({
  passphraseProof: z.string().min(1).max(1024),
  challenge: z.string().min(1).max(256),
}).strict();

const rateLimit = {
  config: {
    security: { public: false },
    rateLimit: {
      max: parseInt(process.env.VAULT_RATE_LIMIT_PER_MINUTE ?? '30', 10),
      timeWindow: '1 minute',
    },
  },
  bodyLimit: BODY_LIMIT,
};

async function getMembership(userId, workspaceId) {
  return WorkspaceMember.findOne({ workspaceId, accountId: userId }).lean();
}

async function requireOwner(app, userId, workspaceId) {
  const membership = await getMembership(userId, workspaceId);
  if (!membership) {
    throw Object.assign(new Error('Not a member of this workspace.'), {
      statusCode: 403,
      code: 'forbidden',
    });
  }
  if (membership.role !== 'owner') {
    throw Object.assign(new Error('Only the vault owner can perform this action.'), {
      statusCode: 403,
      code: 'forbidden',
    });
  }
  return membership;
}

async function requireMember(app, userId, workspaceId) {
  const membership = await getMembership(userId, workspaceId);
  if (!membership) {
    throw Object.assign(new Error('Not a member of this workspace.'), {
      statusCode: 403,
      code: 'forbidden',
    });
  }
  return membership;
}

function hashChallenge(challenge) {
  return crypto.createHash('sha256').update(challenge, 'utf8').digest('hex');
}

async function consumeChallenge({ workspaceId, accountId, challenge }) {
  const now = new Date().toISOString();
  return await transaction(async (client) => {
    const { rows } = await client.query(
      'SELECT id, expires_at FROM vault_proof_challenges WHERE workspace_id = $1 AND account_id = $2 AND challenge_hash = $3 LIMIT 1',
      [workspaceId, accountId, hashChallenge(challenge)]
    );
    const row = rows[0];
    if (!row || row.expires_at <= now) {
      if (row) await client.query('DELETE FROM vault_proof_challenges WHERE id = $1', [row.id]);
      return false;
    }
    const result = await client.query('DELETE FROM vault_proof_challenges WHERE id = $1', [row.id]);
    return result.rowCount === 1;
  });
}

async function vaultRoutes(app) {
  await app.register(require('../middleware/auth'));

  const protect = { preHandler: [app.authenticate] };

  app.post('/:id/challenge', {
    ...rateLimit,
    ...protect,
  }, async (req, reply) => {
    const workspaceId = req.params.id;
    try {
      await requireMember(app, req.userId, workspaceId);
    } catch (err) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    }

    const challenge = crypto.randomBytes(32).toString('base64url');
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + CHALLENGE_TTL_MS).toISOString();
    await query(
      'INSERT INTO vault_proof_challenges (id, workspace_id, account_id, challenge_hash, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [crypto.randomUUID(), workspaceId, req.userId, hashChallenge(challenge), expiresAt, createdAt.toISOString()]
    );
    return reply.send({ challenge, expiresAt });
  });

  // ── PUT /vault/:id/key-params — Owner publishes vault key params ──────
  app.put('/:id/key-params', {
    ...rateLimit,
    ...protect,
  }, async (req, reply) => {
    const workspaceId = req.params.id;

    try {
      await requireOwner(app, req.userId, workspaceId);
    } catch (err) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    }

    const parsed = PublishSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'validation_error',
        message: parsed.error.errors[0].message,
      });
    }

    const { passphraseProof, keyParams, challenge } = parsed.data;
    if (!await consumeChallenge({ workspaceId, accountId: req.userId, challenge })) {
      return reply.status(401).send({ error: 'invalid_challenge', message: 'The vault proof challenge is invalid or expired.' });
    }

    const passphraseHash = await bcrypt.hash(passphraseProof, BCRYPT_ROUNDS);
    const now = new Date().toISOString();

    const existing = await VaultKeyParams.findOne({ workspaceId }).lean();

    if (existing) {
      await VaultKeyParams.updateOne(
        { workspaceId },
        {
          $set: {
            passphraseHash,
            keyParamsBlob: keyParams,
            proofVersion: PROOF_VERSION,
            updatedAt: now,
          },
        }
      );
    } else {
      await VaultKeyParams.create({
        workspaceId,
        ownerId: req.userId,
        passphraseHash,
        keyParamsBlob: keyParams,
        proofVersion: PROOF_VERSION,
        createdAt: now,
        updatedAt: now,
      });
    }

    app.log.info({ workspaceId, userId: req.userId }, 'Vault key params published');
    audit(req, 'vault_key_params_published', { workspaceId });

    return reply.status(200).send({ ok: true, workspaceId });
  });

  // ── GET /vault/:id/key-params — Fetch vault key params (owner only) ───
  app.get('/:id/key-params', {
    ...rateLimit,
    ...protect,
  }, async (req, reply) => {
    const workspaceId = req.params.id;

    try {
      await requireMember(app, req.userId, workspaceId);
    } catch (err) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    }

    const record = await VaultKeyParams.findOne({ workspaceId }).lean();
    if (!record) {
      return reply.status(404).send({
        error: 'not_found',
        message: 'No vault key params found for this workspace.',
      });
    }

    return reply.send({
      workspaceId,
      keyParams: record.keyParamsBlob,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  });

  // ── POST /vault/:id/verify — Joiner verifies passphrase ──────────────
  app.post('/:id/verify', {
    ...rateLimit,
    ...protect,
  }, async (req, reply) => {
    const workspaceId = req.params.id;

    try {
      await requireMember(app, req.userId, workspaceId);
    } catch (err) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    }

    const parsed = VerifySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'validation_error',
        message: parsed.error.errors[0].message,
      });
    }

    const record = await VaultKeyParams.findOne({ workspaceId }).lean();
    if (!record) {
      return reply.status(404).send({
        error: 'not_found',
        message: 'No vault key params found for this workspace.',
      });
    }

    if (!consumeChallenge({ workspaceId, accountId: req.userId, challenge: parsed.data.challenge })) {
      return reply.status(401).send({ error: 'invalid_challenge', message: 'The vault proof challenge is invalid or expired.' });
    }

    if (record.proofVersion !== PROOF_VERSION) {
      return reply.status(409).send({
        error: 'vault_republish_required',
        message: 'The vault owner must republish its key parameters before this vault can be joined.',
      });
    }

    const valid = await bcrypt.compare(parsed.data.passphraseProof, record.passphraseHash);
    if (!valid) {
      return reply.status(401).send({
        error: 'invalid_passphrase',
        message: 'The passphrase is incorrect.',
      });
    }

    app.log.info({ workspaceId, userId: req.userId }, 'Vault passphrase verified');
    audit(req, 'vault_passphrase_verified', { workspaceId });

    return reply.send({
      verified: true,
      workspaceId,
      keyParams: record.keyParamsBlob,
    });
  });

  // ── DELETE /vault/:id/key-params — Owner removes vault key params ─────
  app.delete('/:id/key-params', {
    ...rateLimit,
    ...protect,
  }, async (req, reply) => {
    const workspaceId = req.params.id;

    try {
      await requireOwner(app, req.userId, workspaceId);
    } catch (err) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    }

    const result = await VaultKeyParams.deleteOne({ workspaceId });
    if (result.deletedCount === 0) {
      return reply.status(404).send({
        error: 'not_found',
        message: 'No vault key params found for this workspace.',
      });
    }

    app.log.info({ workspaceId, userId: req.userId }, 'Vault key params removed');
    audit(req, 'vault_key_params_removed', { workspaceId });

    return reply.send({ deleted: true, workspaceId });
  });
}

module.exports = vaultRoutes;
