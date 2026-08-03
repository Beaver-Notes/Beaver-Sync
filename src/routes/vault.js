'use strict';

const bcrypt = require('bcrypt');
const { z } = require('zod');
const { VaultKeyParams, WorkspaceMember } = require('../models');
const { audit } = require('../lib/audit');

const BCRYPT_ROUNDS = 12;

const BODY_LIMIT = parseInt(process.env.VAULT_BODY_LIMIT_BYTES ?? '65536', 10);

const PublishSchema = z.object({
  passphrase: z.string().min(1).max(1024),
  keyParams: z.string().min(1),
});

const VerifySchema = z.object({
  passphrase: z.string().min(1).max(1024),
});

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

    const { passphrase, keyParams } = parsed.data;

    const passphraseHash = await bcrypt.hash(passphrase, BCRYPT_ROUNDS);
    const now = new Date().toISOString();

    const existing = await VaultKeyParams.findOne({ workspaceId }).lean();

    if (existing) {
      await VaultKeyParams.updateOne(
        { workspaceId },
        {
          $set: {
            passphraseHash,
            keyParamsBlob: keyParams,
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

    const valid = await bcrypt.compare(parsed.data.passphrase, record.passphraseHash);
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
