'use strict';

const { z } = require('zod');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const { Account, Credential, Subscription, WebAuthnChallenge } = require('../models');
const { createSession, setSessionCookieIfAvailable, validateSession } = require('../middleware/auth');
const { createEmailHash } = require('../lib/crypto');

async function isAuthenticatedAs(req, accountId) {
  let rawId = null;
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) rawId = authHeader.slice(7);
  if (!rawId && req.cookies?.bsession) rawId = req.cookies.bsession;
  if (!rawId) return false;
  const result = await validateSession(rawId);
  return result && result.userId === accountId;
}

const AUTH_BODY_LIMIT_BYTES = parseInt(process.env.AUTH_BODY_LIMIT_BYTES ?? '16384', 10);

const RP_ID = process.env.WEBAUTHN_RPID;
const RP_ORIGIN = process.env.WEBAUTHN_ORIGIN;
const RP_NAME = process.env.WEBAUTHN_RP_NAME ?? 'Beaver Sync';

if (process.env.NODE_ENV === 'production') {
  if (!RP_ID) {
    console.error('WEBAUTHN_RPID is required in production');
    process.exit(1);
  }
  if (!RP_ORIGIN) {
    console.error('WEBAUTHN_ORIGIN is required in production');
    process.exit(1);
  }
}

const BeginRegisterSchema = z.object({
  email: z.string().email('Invalid email address').max(254),
  deviceLabel: z.string().min(1).max(128),
});

const CompleteRegisterSchema = z.object({
  email: z.string().email('Invalid email address').max(254),
  registrationResponse: z.object({}).passthrough(),
});

const BeginLoginSchema = z.object({
  email: z.string().email('Invalid email address').max(254),
});

const CompleteLoginSchema = z.object({
  email: z.string().email('Invalid email address').max(254),
  authenticationResponse: z.object({}).passthrough(),
});

function normalizeEmail(input) {
  return String(input || '').trim().toLowerCase();
}

async function passkeyRoutes(app) {
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

  app.post('/passkey/register/begin', authRateLimit, async (req, reply) => {
    const parsed = BeginRegisterSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', message: parsed.error.errors[0].message });
    }

    const email = normalizeEmail(parsed.data.email);
    const emailHash = createEmailHash(email);
    const deviceLabel = String(parsed.data.deviceLabel).slice(0, 128);

    let account = await Account.findOne({ emailHmac: emailHash });
    let isNewAccount = false;
    if (!account) {
      const kdfSalt = require('crypto').randomBytes(32).toString('hex');
      account = await Account.create({ emailHmac: emailHash, passwordHash: null, kdfSalt });
      isNewAccount = true;
    }
    if (!isNewAccount) {
      const authed = await isAuthenticatedAs(req, account.id);
      if (!authed) {
        app.recordSecurityEvent(req, 'passkey_register_rejected_existing_account', { emailHash });
        return reply.status(403).send({
          error: 'forbidden',
          message: 'An account with this email already exists. Please sign in to add a passkey.',
        });
      }
    }

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID ?? 'localhost',
      userID: Buffer.from(account.id, 'utf8'),
      userName: email,
      userDisplayName: deviceLabel,
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
    });

    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    await WebAuthnChallenge.create({ emailHmac: emailHash, challenge: options.challenge, expiresAt });

    return reply.send(options);
  });

  app.post('/passkey/register/complete', authRateLimit, async (req, reply) => {
    const parsed = CompleteRegisterSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', message: parsed.error.errors[0].message });
    }

    const email = normalizeEmail(parsed.data.email);
    const emailHash = createEmailHash(email);
    const { registrationResponse } = parsed.data;

    const challengeDoc = await WebAuthnChallenge.findOneAndDelete({ emailHmac: emailHash });
    if (!challengeDoc) {
      app.recordSecurityEvent(req, 'passkey_expired_challenge', { emailHash });
      return reply.status(400).send({ error: 'challenge_expired', message: 'Challenge expired or not found.' });
    }

    const account = await Account.findOne({ emailHmac: emailHash });
    if (!account) {
      return reply.status(400).send({ error: 'account_not_found', message: 'Beaver Account not found.' });
    }

    // Existing accounts must be authenticated to add a new credential — prevents takeover.
    const existingCreds = await Credential.find({ accountId: account.id }).lean();
    const isBrandNew =
      existingCreds.length === 0 &&
      account.createdAt &&
      Date.now() - new Date(account.createdAt).getTime() < 60_000;
    if (!isBrandNew) {
      const authed = await isAuthenticatedAs(req, account.id);
      if (!authed) {
        app.recordSecurityEvent(req, 'passkey_register_rejected_existing_account_complete', { emailHash });
        return reply.status(403).send({
          error: 'forbidden',
          message: 'An account with this email already exists. Please sign in to add a passkey.',
        });
      }
    }

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: registrationResponse,
        expectedChallenge: challengeDoc.challenge,
        expectedOrigin: RP_ORIGIN ?? 'http://localhost:3000',
        expectedRPID: RP_ID ?? 'localhost',
      });
    } catch (err) {
      app.recordSecurityEvent(req, 'passkey_registration_failure', { emailHash, reason: err.message });
      return reply.status(400).send({ error: 'registration_failed', message: err.message });
    }

    if (!verification.verified || !verification.registrationInfo) {
      app.recordSecurityEvent(req, 'passkey_registration_failure', { emailHash });
      return reply.status(400).send({ error: 'registration_failed', message: 'Registration verification failed.' });
    }

    const { credential } = verification.registrationInfo;
    const deviceLabel = String(parsed.data.deviceLabel ?? 'Unknown Device').slice(0, 128);

    await Credential.create({
      accountId: account.id,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      signCount: credential.counter ?? 0,
      deviceLabel,
    });

    const token = await createSession(account.id, req);

    return reply.status(201).send({
      sessionToken: token,
      user: {
        id: account.id,
        emailHash: account.emailHmac,
        kdfSalt: account.kdfSalt,
      },
    });
  });

  app.post('/passkey/login/begin', authRateLimit, async (req, reply) => {
    const parsed = BeginLoginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', message: parsed.error.errors[0].message });
    }

    const email = normalizeEmail(parsed.data.email);
    const emailHash = createEmailHash(email);
    const account = await Account.findOne({ emailHmac: emailHash });

    if (!account) {
      app.recordSecurityEvent(req, 'passkey_login_unknown_account', { emailHash });
      const decoy = await generateAuthenticationOptions({
        rpID: RP_ID ?? 'localhost',
        allowCredentials: [],
      });
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
      await WebAuthnChallenge.create({ emailHmac: emailHash, challenge: decoy.challenge, expiresAt });
      return reply.send(decoy);
    }

    const credentials = await Credential.find({ accountId: account.id }).lean();
    const allowCredentials = credentials.map((c) => ({
      id: c.credentialId,
      type: 'public-key',
    }));

    const options = await generateAuthenticationOptions({
      rpID: RP_ID ?? 'localhost',
      allowCredentials,
    });

    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    await WebAuthnChallenge.create({ emailHmac: emailHash, challenge: options.challenge, expiresAt });

    return reply.send(options);
  });

  app.post('/passkey/login/complete', authRateLimit, async (req, reply) => {
    const parsed = CompleteLoginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', message: parsed.error.errors[0].message });
    }

    const email = normalizeEmail(parsed.data.email);
    const emailHash = createEmailHash(email);
    const { authenticationResponse } = parsed.data;

    const challengeDoc = await WebAuthnChallenge.findOneAndDelete({ emailHmac: emailHash });
    if (!challengeDoc) {
      app.recordSecurityEvent(req, 'passkey_expired_challenge', { emailHash });
      return reply.status(400).send({ error: 'challenge_expired', message: 'Challenge expired or not found.' });
    }

    const account = await Account.findOne({ emailHmac: emailHash });
    if (!account) {
      return reply.status(401).send({ error: 'invalid_credentials', message: 'Beaver Account not found.' });
    }

    const credentialDoc = await Credential.findOne({
      accountId: account.id,
      credentialId: authenticationResponse.id,
    });

    if (!credentialDoc) {
      app.recordSecurityEvent(req, 'passkey_login_unknown_credential', { emailHash });
      return reply.status(401).send({ error: 'invalid_credentials', message: 'Credential not found.' });
    }

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: authenticationResponse,
        expectedChallenge: challengeDoc.challenge,
        expectedOrigin: RP_ORIGIN ?? 'http://localhost:3000',
        expectedRPID: RP_ID ?? 'localhost',
        authenticator: {
          credentialID: credentialDoc.credentialId,
          credentialPublicKey: Buffer.from(credentialDoc.publicKey, 'base64url'),
          counter: credentialDoc.signCount,
        },
      });
    } catch (err) {
      app.recordSecurityEvent(req, 'passkey_login_failure', { emailHash, reason: err.message });
      return reply.status(401).send({ error: 'invalid_credentials', message: err.message });
    }

    if (!verification.verified) {
      app.recordSecurityEvent(req, 'passkey_login_failure', { emailHash });
      return reply.status(401).send({ error: 'invalid_credentials', message: 'Authentication verification failed.' });
    }

    const newCounter = verification.authenticationInfo.newCounter;
    if (newCounter <= credentialDoc.signCount) {
      app.recordSecurityEvent(req, 'passkey_replay_attack', { emailHash, credentialId: credentialDoc.credentialId });
      return reply.status(401).send({ error: 'replay_detected', message: 'Authentication response replay detected.' });
    }

    credentialDoc.signCount = newCounter;
    await credentialDoc.save();

    const token = await createSession(account.id, req);

    const subscription = await Subscription.findOne(
      { accountId: account.id },
      { plan: 1, status: 1, renewsAt: 1, storageUsedBytes: 1, storageQuotaBytes: 1 }
    ).lean();

    setSessionCookieIfAvailable(app, reply, token);
    return reply.send({
      sessionToken: token,
      user: {
        id: account.id,
        emailHash: account.emailHmac,
        kdfSalt: account.kdfSalt,
      },
      subscription: subscription ?? null,
    });
  });
}

module.exports = passkeyRoutes;
