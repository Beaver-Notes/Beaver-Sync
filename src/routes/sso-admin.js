'use strict';

const net = require('net');
const { SsoConfig, Workspace, WorkspaceMember } = require('../models');
const mlkem = require('../lib/mlkem');
const { isEnterpriseMode } = require('../lib/license');
const { resolvePlanForAccount } = require('../lib/plans');

function isBlockedOidcHost(hostname) {
  const h = String(hostname || '').toLowerCase().trim();
  if (!h) return true;
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0') return true;
  if (net.isIP(h)) {
    if (net.isIP(h) === 4) {
      if (h.startsWith('127.') || h.startsWith('0.')) return true;
      if (h.startsWith('10.')) return true;
      if (h.startsWith('192.168.')) return true;
      if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true;
      if (h.startsWith('169.254.')) return true;
    } else {
      if (h === '::1' || h === '::ffff:127.0.0.1') return true;
      if (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;
    }
    return false;
  }
  if (h === 'metadata.google.internal' || h.endsWith('.internal')) return true;
  return false;
}

function validateOidcIssuer(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') return 'oidcIssuer must be a URL string.';
  if (value.length > 2048) return 'oidcIssuer too long.';
  let u;
  try { u = new URL(value); } catch { return 'oidcIssuer must be an absolute URL.'; }
  const isLoopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1';
  const allowHttpLoopback = process.env.NODE_ENV !== 'production' && isLoopback;
  if (u.protocol !== 'https:' && !(allowHttpLoopback && u.protocol === 'http:')) return 'oidcIssuer must use https.';
  if (!u.hostname) return 'oidcIssuer must include a hostname.';
  if (isBlockedOidcHost(u.hostname)) {
    const exemptLoopback = allowHttpLoopback && u.protocol === 'http:' && isLoopback;
    if (!exemptLoopback) return 'oidcIssuer host is not allowed.';
  }
  return null;
}

const BODY_LIMIT = parseInt(process.env.ADMIN_BODY_LIMIT_BYTES ?? '4096', 10);

const rateLimit = {
  config: {
    security: { public: false },
    rateLimit: {
      max: parseInt(process.env.ADMIN_RATE_LIMIT_PER_MINUTE ?? '30', 10),
      timeWindow: '1 minute',
    },
  },
  bodyLimit: BODY_LIMIT,
};

async function requirePlanAndOwner(app, req, reply, workspaceId) {
  const ws = await Workspace.findById(workspaceId, { nameEncrypted: 1, orgId: 1 }).lean();
  if (!ws) {
    return reply.status(404).send({ error: 'not_found', message: 'Workspace not found.' });
  }

  if (!isEnterpriseMode()) {
    const { Subscription, OrgSubscription } = require('../models');
    const sub = await Subscription.findOne({ accountId: req.userId }).lean();
    const orgSub = ws.orgId ? await OrgSubscription.findOne({ orgId: ws.orgId }).lean() : null;
    const effectivePlan = resolvePlanForAccount({ orgSub, sub });
    if (!effectivePlan || (effectivePlan !== 'team' && effectivePlan !== 'enterprise')) {
      return reply.status(403).send({ error: 'forbidden', message: 'SSO requires a Team or Enterprise plan.' });
    }
  }

  const membership = await WorkspaceMember.findOne({ workspaceId, accountId: req.userId }).lean();
  if (!membership || membership.role !== 'owner') {
    return reply.status(403).send({ error: 'forbidden', message: 'Workspace owner access required.' });
  }

  return { ws };
}

async function encryptConfigFields(data) {
  const out = { ...data };
  if (out.idpCert && typeof out.idpCert === 'string') {
    out.idpCertSealed = await mlkem.encryptMetadata(out.idpCert);
    delete out.idpCert;
  }
  if (out.spPrivateKey && typeof out.spPrivateKey === 'string') {
    out.spPrivateKeySealed = await mlkem.encryptMetadata(out.spPrivateKey);
    delete out.spPrivateKey;
  }
  if (out.oidcClientSecret && typeof out.oidcClientSecret === 'string') {
    out.oidcClientSecretSealed = await mlkem.encryptMetadata(out.oidcClientSecret);
    delete out.oidcClientSecret;
  }
  return out;
}

function sanitizeConfig(raw) {
  const config = { ...raw };
  delete config.idpCertSealed;
  delete config.spPrivateKeySealed;
  delete config.oidcClientSecretSealed;
  if (config.idpCert) config.idpCert = true;
  if (config.spPrivateKey) config.spPrivateKey = true;
  if (config.oidcClientSecret) config.oidcClientSecret = true;
  return config;
}

async function ssoAdminRoutes(app) {
  await app.register(require('../middleware/auth'));

  const protect = { preHandler: [app.authenticate] };

  app.get('/workspaces/:id/sso', {
    ...rateLimit,
    ...protect,
  }, async (req, reply) => {
    const ownerCheck = await requirePlanAndOwner(app, req, reply, req.params.id);
    if (!ownerCheck) return;

    const configs = await SsoConfig.find({ workspaceId: req.params.id }).lean();
    return { configs: configs.map(sanitizeConfig) };
  });

  app.post('/workspaces/:id/sso', {
    ...rateLimit,
    ...protect,
  }, async (req, reply) => {
    const ownerCheck = await requirePlanAndOwner(app, req, reply, req.params.id);
    if (!ownerCheck) return;

    const { protocol, slug, idpEntityId, idpSsoUrl, idpCert, oidcIssuer, oidcClientId, oidcClientSecret, spCert, spPrivateKey, allowedEmailDomains } = req.body || {};

    if (!protocol || !slug) {
      return reply.status(400).send({ error: 'bad_request', message: 'protocol and slug are required.' });
    }
    if (protocol !== 'saml' && protocol !== 'oidc') {
      return reply.status(400).send({ error: 'bad_request', message: 'protocol must be "saml" or "oidc".' });
    }
    if (!/^[a-z0-9-]+$/.test(slug)) {
      return reply.status(400).send({ error: 'bad_request', message: 'slug must contain only lowercase letters, numbers, and hyphens.' });
    }
    if (protocol === 'oidc') {
      const oidcErr = validateOidcIssuer(oidcIssuer);
      if (oidcErr) return reply.status(400).send({ error: 'bad_request', message: oidcErr });
      if (!oidcIssuer) return reply.status(400).send({ error: 'bad_request', message: 'oidcIssuer is required for OIDC.' });
    }

    const existing = await SsoConfig.findOne({ slug }).lean();
    if (existing) {
      return reply.status(409).send({ error: 'conflict', message: 'A SSO config with this slug already exists.' });
    }

    const encrypted = await encryptConfigFields({ idpCert, spPrivateKey, oidcClientSecret });

    const config = await SsoConfig.create({
      workspaceId: req.params.id,
      protocol,
      slug,
      idpEntityId: idpEntityId || null,
      idpSsoUrl: idpSsoUrl || null,
      idpCertSealed: encrypted.idpCertSealed || null,
      oidcIssuer: oidcIssuer || null,
      oidcClientId: oidcClientId || null,
      oidcClientSecretSealed: encrypted.oidcClientSecretSealed || null,
      spCert: spCert || null,
      spPrivateKeySealed: encrypted.spPrivateKeySealed || null,
      allowedEmailDomains: allowedEmailDomains || null,
    });

    return reply.status(201).send({ config: sanitizeConfig(config) });
  });

  app.get('/workspaces/:id/sso/:configId', {
    ...rateLimit,
    ...protect,
  }, async (req, reply) => {
    const ownerCheck = await requirePlanAndOwner(app, req, reply, req.params.id);
    if (!ownerCheck) return;

    const config = await SsoConfig.findOne({ id: req.params.configId, workspaceId: req.params.id }).lean();
    if (!config) {
      return reply.status(404).send({ error: 'not_found', message: 'SSO config not found.' });
    }

    return { config: sanitizeConfig(config) };
  });

  app.patch('/workspaces/:id/sso/:configId', {
    ...rateLimit,
    ...protect,
  }, async (req, reply) => {
    const ownerCheck = await requirePlanAndOwner(app, req, reply, req.params.id);
    if (!ownerCheck) return;

    const config = await SsoConfig.findOne({ id: req.params.configId, workspaceId: req.params.id }).lean();
    if (!config) {
      return reply.status(404).send({ error: 'not_found', message: 'SSO config not found.' });
    }

    const { protocol, slug, idpEntityId, idpSsoUrl, idpCert, oidcIssuer, oidcClientId, oidcClientSecret, spCert, spPrivateKey, allowedEmailDomains } = req.body || {};

    if (oidcIssuer !== undefined) {
      const oidcErr = validateOidcIssuer(oidcIssuer);
      if (oidcErr) return reply.status(400).send({ error: 'bad_request', message: oidcErr });
    }
    if (slug && slug !== config.slug) {
      if (!/^[a-z0-9-]+$/.test(slug)) {
        return reply.status(400).send({ error: 'bad_request', message: 'slug must contain only lowercase letters, numbers, and hyphens.' });
      }
      const dup = await SsoConfig.findOne({ slug }).lean();
      if (dup) {
        return reply.status(409).send({ error: 'conflict', message: 'A SSO config with this slug already exists.' });
      }
    }

    const update = {};
    if (protocol) update.protocol = protocol;
    if (slug) update.slug = slug;
    if (idpEntityId !== undefined) update.idpEntityId = idpEntityId;
    if (idpSsoUrl !== undefined) update.idpSsoUrl = idpSsoUrl;
    if (oidcIssuer !== undefined) update.oidcIssuer = oidcIssuer;
    if (oidcClientId !== undefined) update.oidcClientId = oidcClientId;
    if (spCert !== undefined) update.spCert = spCert;
    if (allowedEmailDomains !== undefined) update.allowedEmailDomains = allowedEmailDomains;

    if (idpCert || spPrivateKey || oidcClientSecret) {
      const encrypted = await encryptConfigFields({ idpCert, spPrivateKey, oidcClientSecret });
      if (encrypted.idpCertSealed) update.idpCertSealed = encrypted.idpCertSealed;
      if (encrypted.spPrivateKeySealed) update.spPrivateKeySealed = encrypted.spPrivateKeySealed;
      if (encrypted.oidcClientSecretSealed) update.oidcClientSecretSealed = encrypted.oidcClientSecretSealed;
    }

    const updated = await SsoConfig.findOneAndUpdate(
      { id: req.params.configId },
      { $set: update },
      { new: true },
    ).lean();

    return { config: sanitizeConfig(updated) };
  });

  app.delete('/workspaces/:id/sso/:configId', {
    ...rateLimit,
    ...protect,
  }, async (req, reply) => {
    const ownerCheck = await requirePlanAndOwner(app, req, reply, req.params.id);
    if (!ownerCheck) return;

    const config = await SsoConfig.findOne({ id: req.params.configId, workspaceId: req.params.id }).lean();
    if (!config) {
      return reply.status(404).send({ error: 'not_found', message: 'SSO config not found.' });
    }

    await SsoConfig.deleteOne({ id: req.params.configId });
    return { success: true };
  });
}

module.exports = ssoAdminRoutes;
