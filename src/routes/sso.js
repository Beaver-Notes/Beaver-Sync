'use strict';

const crypto = require('crypto');
const net = require('net');
const { SAML, generateServiceProviderMetadata } = require('@node-saml/node-saml');
const { Issuer } = require('openid-client');
const { SsoConfig, SsoOidcState, Account } = require('../models');
const mlkem = require('../lib/mlkem');
const { createEmailHash } = require('../lib/crypto');
const { createSession, createRefreshToken } = require('../middleware/auth');
const { isEnterpriseMode } = require('../lib/license');

const APP_URL = process.env.APP_URL ?? 'http://localhost:3000';
const SSO_STATE_TTL_MS = 10 * 60 * 1000;
const OIDC_ISSUER_CACHE_TTL_MS = 60 * 60 * 1000;

// One-time exchange codes reuse the ws_tickets table (hash PK + TTL); the
// completion page swaps ?code= for a session via POST /sso/exchange so tokens
// never appear in URLs or referrer/history.
async function issueExchangeCode(accountId) {
  const { hashSessionId } = require('../lib/crypto');
  const { getDb } = require('../db');
  const code = crypto.randomBytes(32).toString('base64url');
  await getDb().query('DELETE FROM ws_tickets WHERE expires_at < NOW()');
  await getDb().query(
    'INSERT INTO ws_tickets (id_hash, account_id, device_id, role, expires_at) VALUES ($1,$2,NULL,NULL, NOW() + make_interval(secs => $3))',
    [hashSessionId(`sso-exchange:${code}`), accountId, parseInt(process.env.SSO_EXCHANGE_TTL_SECONDS ?? '60', 10)]
  );
  return code;
}

// OIDC discovery does a network fetch of the well-known document; cache it per
// issuer so logins don't pay a round-trip on every request.
const oidcIssuerCache = new Map();

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
    } else if (h === '::1' || h === '::ffff:127.0.0.1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;
    return false;
  }
  if (h === 'metadata.google.internal' || h.endsWith('.internal')) return true;
  return false;
}

async function discoverOidcIssuer(issuerUrl) {
  let parsed;
  try { parsed = new URL(issuerUrl); } catch { throw Object.assign(new Error('Invalid OIDC issuer URL'), { statusCode: 400 }); }
  const isLoopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1';
  const allowHttpLoopback = process.env.NODE_ENV !== 'production' && isLoopback;
  if (parsed.protocol !== 'https:' && !(allowHttpLoopback && parsed.protocol === 'http:')) throw Object.assign(new Error('OIDC issuer must use https'), { statusCode: 400 });
  if (isBlockedOidcHost(parsed.hostname)) {
    const exemptLoopback = allowHttpLoopback && parsed.protocol === 'http:' && isLoopback;
    if (!exemptLoopback) throw Object.assign(new Error('OIDC issuer host not allowed'), { statusCode: 400 });
  }
  const cached = oidcIssuerCache.get(issuerUrl);
  if (cached && Date.now() - cached.at < OIDC_ISSUER_CACHE_TTL_MS) return cached.issuer;
  const issuer = await Issuer.discover(issuerUrl);
  oidcIssuerCache.set(issuerUrl, { issuer, at: Date.now() });
  return issuer;
}

function safeRedirectTarget(value, fallback) {
  if (!value || typeof value !== 'string') return fallback;
  if (value.length > 1024) return fallback;
  if (value.includes('\r') || value.includes('\n')) return fallback;
  if (/^(https?:)?\/\//i.test(value)) {
    try {
      const allowed = (process.env.ALLOWED_ORIGINS || APP_URL).split(',').map((s) => s.trim()).filter(Boolean);
      if (!allowed.length) return fallback;
      const target = new URL(value);
      return allowed.some((origin) => {
        const o = new URL(origin);
        return target.protocol === o.protocol && target.host === o.host && (target.pathname === o.pathname || o.pathname === '/' || target.pathname.startsWith(o.pathname));
      }) ? value : fallback;
    } catch {
      return fallback;
    }
  }
  if (value.startsWith('/')) return value;
  return fallback;
}

async function getConfig(slug) {
  const raw = await SsoConfig.findOne({ slug }).lean();
  if (!raw) return null;
  return raw;
}

async function decryptConfig(raw) {
  const config = { ...raw };
  if (config.idpCertEncrypted) {
    const pem = await mlkem.decryptMetadata(config.idpCertEncrypted);
    config.idpCert = pem;
  }
  if (config.spPrivateKeyEncrypted) {
    const key = await mlkem.decryptMetadata(config.spPrivateKeyEncrypted);
    config.spPrivateKey = key;
  }
  if (config.oidcClientSecretEncrypted) {
    config.oidcClientSecret = await mlkem.decryptMetadata(config.oidcClientSecretEncrypted);
  }
  return config;
}

function buildSamlInstance(config) {
  return new SAML({
    callbackUrl: `${APP_URL}/auth/sso/${config.slug}/acs`,
    entryPoint: config.idpSsoUrl,
    issuer: `${APP_URL}/auth/sso/${config.slug}/metadata`,
    cert: config.idpCert,
    privateKey: config.spPrivateKey,
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: true,
    acceptedClockSkewMs: 5 * 60 * 1000,
    disableRequestedAuthnContext: true,
  });
}

async function jitProvision(email, config, opts = {}) {
  const { emailVerified = true } = opts;
  // OIDC must present email_verified=true; SAML assertions are already trusted
  if (emailVerified !== true) return null;

  const normalized = String(email).trim().toLowerCase();
  const domain = normalized.split('@')[1] ?? '';

  const allowedHosts = config && (config.allowedEmailDomains && String(config.allowedEmailDomains))
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean) || [];
  if (allowedHosts.length > 0 && !allowedHosts.some((allowed) => domain === allowed || normalized.endsWith('.' + allowed))) {
    return null;
  }

  const emailHash = createEmailHash(normalized);
  let account = await Account.findOne({ emailHmac: emailHash }).lean();
  if (!account) {
    account = await Account.create({
      emailHmac: emailHash,
      emailEncrypted: await mlkem.encryptMetadata(normalized),
      createdAt: new Date(),
    });
    const { Subscription } = require('../models');
    await Subscription.create({ accountId: account.id, plan: 'free', status: 'active', storageQuotaBytes: 0, createdAt: new Date() });
    return account;
  }
  // Existing account: default-deny JIT linking unless domain explicitly allow-listed
  if (allowedHosts.length === 0) return null;
  return account;
}

async function ssoRoutes(app) {
  app.get('/sso/:slug/metadata', async (req, reply) => {
    const raw = await getConfig(req.params.slug);
    if (!raw || raw.protocol !== 'saml') return reply.status(404).send({ error: 'not_found' });

    const config = await decryptConfig(raw);
    const metadata = generateServiceProviderMetadata({
      issuer: `${APP_URL}/auth/sso/${config.slug}/metadata`,
      callbackUrl: `${APP_URL}/auth/sso/${config.slug}/acs`,
      wantAuthnResponseSigned: true,
      wantAssertionsSigned: true,
    });

    reply.header('Content-Type', 'application/xml');
    return reply.send(metadata);
  });

  app.get('/sso/:slug/login', async (req, reply) => {
    const raw = await getConfig(req.params.slug);
    if (!raw) return reply.status(404).send({ error: 'not_found' });

    if (!isEnterpriseMode()) {
      const { Workspace, Subscription } = require('../models');
      const ws = await Workspace.findById(raw.workspaceId, { ownerId: 1 }).lean();
      if (ws) {
        const sub = await Subscription.findOne({ accountId: ws.ownerId }).lean();
        if (!sub || sub.plan !== 'enterprise') {
          return reply.status(403).send({ error: 'forbidden', message: 'SSO requires an Enterprise plan.' });
        }
      }
    }

    const config = await decryptConfig(raw);

    if (config.protocol === 'oidc') {
      const issuer = await discoverOidcIssuer(config.oidcIssuer);
      const client = new issuer.Client({
        client_id: config.oidcClientId,
        client_secret: config.oidcClientSecret,
        redirect_uris: [`${APP_URL}/auth/sso/${config.slug}/oidc/callback`],
        response_types: ['code'],
      });

      const codeVerifier = crypto.randomBytes(32).toString('base64url');
      const state = crypto.randomBytes(16).toString('hex');

      await SsoOidcState.create({
        state,
        codeVerifier,
        slug: config.slug,
        createdAt: new Date(),
      });

      const url = client.authorizationUrl({
        scope: 'openid email profile',
        state,
        code_challenge_method: 'S256',
        code_challenge: crypto.createHash('sha256').update(codeVerifier).digest('base64url'),
      });

      return reply.code(301).redirect(url);
    }

    const saml = buildSamlInstance(config);
    const host = req.headers['host'] ?? 'localhost';
    const url = await saml.getAuthorizeUrlAsync('', host, {});
    return reply.code(301).redirect(url);
  });

  app.post('/sso/:slug/acs', async (req, reply) => {
    const raw = await getConfig(req.params.slug);
    if (!raw || raw.protocol !== 'saml') return reply.status(404).send({ error: 'not_found' });

    const config = await decryptConfig(raw);
    const saml = buildSamlInstance(config);

    let profile;
    try {
      profile = await saml.validatePostResponseAsync(req.body);
    } catch (err) {
      app.log.warn({ err, slug: config.slug }, 'SAML ACS validation failed');
      return reply.status(401).send({ error: 'saml_validation_failed', message: 'SAML response validation failed.' });
    }

    const email = profile?.email ?? profile?.nameID;
    if (!email) {
      return reply.status(400).send({ error: 'email_required', message: 'SAML assertion did not include an email address.' });
    }

    const account = await jitProvision(email, config);
    if (!account) {
      return reply.status(403).send({ error: 'forbidden', message: 'Email domain is not permitted by this SSO configuration.' });
    }
    const token = await createSession(account.id, req, config.workspaceId);

    const fallback = `${APP_URL}/auth/sso/${config.slug}/complete`;
    const redirectTo = safeRedirectTarget(req.query?.RelayState, fallback);
    if (typeof app.setSessionCookie === 'function') app.setSessionCookie(reply, token);
    reply.header('Referrer-Policy', 'no-referrer');
    const code = await issueExchangeCode(account.id);
    return reply.code(302).redirect(`${redirectTo}?code=${encodeURIComponent(code)}`);
  });

  app.get('/sso/:slug/oidc/callback', async (req, reply) => {
    const raw = await getConfig(req.params.slug);
    if (!raw || raw.protocol !== 'oidc') return reply.status(404).send({ error: 'not_found' });

    const config = await decryptConfig(raw);
    const state = req.query.state;

    if (!state) return reply.status(400).send({ error: 'missing_state' });

    const stateRow = await SsoOidcState.findOneAndDelete({ state });
    if (!stateRow) return reply.status(400).send({ error: 'invalid_state' });

    if (Date.now() - new Date(stateRow.createdAt).getTime() > SSO_STATE_TTL_MS) {
      return reply.status(400).send({ error: 'state_expired' });
    }

    const issuer = await discoverOidcIssuer(config.oidcIssuer);
    const client = new issuer.Client({
      client_id: config.oidcClientId,
      client_secret: config.oidcClientSecret,
      redirect_uris: [`${APP_URL}/auth/sso/${config.slug}/oidc/callback`],
      response_types: ['code'],
    });

    let tokenSet;
    try {
      tokenSet = await client.callback(
        `${APP_URL}/auth/sso/${config.slug}/oidc/callback`,
        { code: req.query.code, state: req.query.state },
        { code_verifier: stateRow.codeVerifier }
      );
    } catch (err) {
      app.log.warn({ err, slug: config.slug }, 'OIDC callback failed');
      return reply.status(401).send({ error: 'oidc_callback_failed', message: 'OIDC token exchange failed.' });
    }

    const userinfo = await client.userinfo(tokenSet);
    const email = userinfo.email;
    if (!email) {
      return reply.status(400).send({ error: 'email_required', message: 'OIDC provider did not return an email address.' });
    }
    if (userinfo.email_verified !== true) {
      return reply.status(403).send({ error: 'email_not_verified', message: 'OIDC email must be verified.' });
    }

    const account = await jitProvision(email, config, { emailVerified: userinfo.email_verified });
    if (!account) {
      return reply.status(403).send({ error: 'forbidden', message: 'Email domain is not permitted by this SSO configuration.' });
    }
    const token = await createSession(account.id, req, config.workspaceId);

    const redirectTo = `${APP_URL}/auth/sso/${config.slug}/complete`;
    if (typeof app.setSessionCookie === 'function') app.setSessionCookie(reply, token);
    reply.header('Referrer-Policy', 'no-referrer');
    const code = await issueExchangeCode(account.id);
    return reply.code(302).redirect(`${redirectTo}?code=${encodeURIComponent(code)}`);
  });

  app.post('/sso/exchange', {
    config: {
      security: { public: true },
      rateLimit: { max: 30, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    const code = req.body?.code;
    if (typeof code !== 'string' || code.length < 16) {
      return reply.status(400).send({ error: 'invalid_code' });
    }
    const { hashSessionId } = require('../lib/crypto');
    const { getDb } = require('../db');
    const redeemed = await getDb().query(
      'DELETE FROM ws_tickets WHERE id_hash = $1 AND expires_at > NOW() AND role IS NULL RETURNING account_id',
      [hashSessionId(`sso-exchange:${code}`)]
    );
    if (redeemed.rowCount === 0) {
      return reply.status(401).send({ error: 'invalid_code', message: 'Exchange code is invalid or expired.' });
    }
    const token = await createSession(redeemed.rows[0].account_id, req);
    const refreshToken = await createRefreshToken(redeemed.rows[0].account_id, token, req);
    return reply.send({ token, sessionToken: token, refreshToken });
  });
}

module.exports = ssoRoutes;
