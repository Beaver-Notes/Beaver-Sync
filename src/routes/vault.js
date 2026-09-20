'use strict';

const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { z } = require('zod');
const { VaultKeyParams, WorkspaceMember } = require('../models');
const { query } = require('../db');
const { createVaultChallenge, consumeVaultChallenge } = require('../repositories/vaultProofChallenge');
const {
  adoptAccountVaultKeyParams,
  publishAccountVaultKeyParams,
} = require('../repositories/accountVaultKeyParams');
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

const AccountPublishSchema = z.object({
  keyParams: z.string().min(1),
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

async function vaultRoutes(app) {
  await app.register(require('../middleware/auth'));

  const protect = { preHandler: [app.authenticate] };

  // Account-scoped vault key params (Phase 2): one vault key per account.
  // The per-workspace `/:id/key-params` routes below stay for migration and for
  // old clients; the account row is adopted from the oldest per-workspace row
  // the caller published. Adoption is deterministic, idempotent and never
  // deletes or rewrites the per-workspace rows. Authentication alone is enough:
  // the row is the caller's own and `keyParams` is an opaque client blob.
  app.get('/account/key-params', {
    ...rateLimit,
    ...protect,
  }, async (req, reply) => {
    const row = await adoptAccountVaultKeyParams(req.userId);
    if (!row) {
      return reply.status(404).send({
        error: 'not_found',
        message: 'No vault key params found for this account.',
      });
    }
    return reply.send({
      accountId: req.userId,
      id: row.id,
      keyParams: row.key_params_blob,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  });

  app.put('/account/key-params', {
    ...rateLimit,
    ...protect,
  }, async (req, reply) => {
    const parsed = AccountPublishSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'validation_error',
        message: parsed.error.errors[0].message,
      });
    }

    const row = await publishAccountVaultKeyParams(req.userId, req.userId, parsed.data.keyParams);
    if (!row) {
      return reply.status(409).send({
        error: 'vault_already_exists',
        message: 'An account vault already exists. Import it with its vault key instead.',
      });
    }

    app.log.info({ userId: req.userId }, 'Account vault key params published');
    audit(req, 'account_vault_key_params_published', {});
    return reply.status(200).send({ ok: true, accountId: req.userId });
  });

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
    await createVaultChallenge({ workspaceId, accountId: req.userId, challenge, expiresAt, createdAt: createdAt.toISOString() });
    return reply.send({ challenge, expiresAt });
  });

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

    const existing = await VaultKeyParams.findOne({ workspaceId }).lean();

    // A different device already created this vault. Overwriting here would
    // replace its wrapped key and orphan everything encrypted with it, so
    // refuse and make the caller import the existing vault with its password.
    // Re-publishing an identical blob stays idempotent.
    if (existing) {
      if (existing.keyParamsBlob !== keyParams) {
        return reply.status(409).send({
          error: 'vault_already_exists',
          message: 'A vault already exists for this workspace. Import it with its password instead.',
        });
      }
      if (!await consumeVaultChallenge({ workspaceId, accountId: req.userId, challenge })) {
        return reply.status(401).send({ error: 'invalid_challenge', message: 'The vault proof challenge is invalid or expired.' });
      }
      const passphraseHash = await bcrypt.hash(passphraseProof, BCRYPT_ROUNDS);
      const now = new Date().toISOString();
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
      app.log.info({ workspaceId, userId: req.userId }, 'Vault key params published');
      audit(req, 'vault_key_params_published', { workspaceId });
      return reply.status(200).send({ ok: true, workspaceId });
    }

    // No vault yet. Claim it with a single atomic insert so a concurrent
    // publisher gets a clean 409 instead of a primary-key 500 — and so the
    // losing request does not consume its single-use challenge.
    const passphraseHash = await bcrypt.hash(passphraseProof, BCRYPT_ROUNDS);
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const { rowCount } = await query(
      `INSERT INTO vault_key_params
         (id, workspace_id, owner_id, passphrase_hash, key_params_blob, proof_version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (workspace_id) DO NOTHING`,
      [id, workspaceId, req.userId, passphraseHash, keyParams, PROOF_VERSION, now, now]
    );

    if (rowCount === 0) {
      const winner = await VaultKeyParams.findOne({ workspaceId }).lean();
      if (!winner || winner.keyParamsBlob !== keyParams) {
        return reply.status(409).send({
          error: 'vault_already_exists',
          message: 'A vault already exists for this workspace. Import it with its password instead.',
        });
      }
      // Same blob as the winner: idempotent republish, safe to consume now.
      if (!await consumeVaultChallenge({ workspaceId, accountId: req.userId, challenge })) {
        return reply.status(401).send({ error: 'invalid_challenge', message: 'The vault proof challenge is invalid or expired.' });
      }
      await VaultKeyParams.updateOne(
        { workspaceId },
        { $set: { passphraseHash, proofVersion: PROOF_VERSION, updatedAt: now } }
      );
      app.log.info({ workspaceId, userId: req.userId }, 'Vault key params republished');
      audit(req, 'vault_key_params_published', { workspaceId });
      return reply.status(200).send({ ok: true, workspaceId });
    }

    // We won the claim; validate the proof only now. A bad/expired challenge
    // rolls the claim back so the caller can retry with a fresh one.
    if (!await consumeVaultChallenge({ workspaceId, accountId: req.userId, challenge })) {
      await VaultKeyParams.deleteOne({ workspaceId, _id: id });
      return reply.status(401).send({ error: 'invalid_challenge', message: 'The vault proof challenge is invalid or expired.' });
    }

    app.log.info({ workspaceId, userId: req.userId }, 'Vault key params published');
    audit(req, 'vault_key_params_published', { workspaceId });

    return reply.status(200).send({ ok: true, workspaceId });
  });

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

    if (!await consumeVaultChallenge({ workspaceId, accountId: req.userId, challenge: parsed.data.challenge })) {
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
