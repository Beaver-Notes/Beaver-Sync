'use strict';

require('dotenv').config();

const Fastify = require('fastify');
const { getDb } = require('./db');

function validateRequiredEnv() {
  const missing = [];
  const isProduction = process.env.NODE_ENV === 'production';
  const legacyAuth = process.env.LEGACY_AUTH_ENABLED === 'true';

  function requireVar(name, condition = true, minLength = 0) {
    const value = process.env[name];
    if (!condition) return;
    if (!value || (minLength > 0 && value.length < minLength)) {
      missing.push(name);
    }
  }

  if (!process.env.DATABASE_URL) {
    missing.push('DATABASE_URL');
  }
  requireVar('SESSION_HMAC_KEY', true, 32);
  requireVar('EMAIL_HMAC_KEY', true, 32);
  requireVar('COOKIE_SECRET', true, 32);
  requireVar('NOTE_HMAC_KEY', isProduction, 32);
  requireVar('JWT_PRIVATE_KEY_PATH', legacyAuth);
  requireVar('JWT_PUBLIC_KEY_PATH', legacyAuth);
  requireVar('WEBAUTHN_RPID', isProduction);
  requireVar('WEBAUTHN_ORIGIN', isProduction);

  if (missing.length > 0) {
    console.error('Missing required environment variables:');
    for (const name of missing) {
      console.error(`   - ${name}`);
    }
    process.exit(1);
  }

  const DEFAULT_SECRETS = [
    'change-me-session-hmac-key-min-32-chars',
    'change-me-email-hmac-key-min-32-chars',
    'change-me-note-hmac-key-min-32-chars',
    'change-me-cookie-secret',
  ];

  for (const name of ['SESSION_HMAC_KEY', 'EMAIL_HMAC_KEY', 'NOTE_HMAC_KEY', 'COOKIE_SECRET']) {
    if (DEFAULT_SECRETS.includes(process.env[name])) {
      console.warn(`WARNING: ${name} is using a default value. Generate a real key for production.`);
    }
  }

  if (legacyAuth) {
    console.info('Password/email authentication is enabled alongside passkeys.');
  }

  if (!process.env.NOTE_HMAC_KEY || process.env.NOTE_HMAC_KEY.length < 32) {
    console.warn('NOTE_HMAC_KEY is not configured. Note history endpoints will return empty results.');
  }
}

validateRequiredEnv();

async function buildApp() {
  const { initErrorMonitoring } = require('./lib/error-monitoring');
  initErrorMonitoring(process.env.GLITCHTIP_DSN);

  const mlkem = require('./lib/mlkem');
  await mlkem.init();

  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === 'production' ? 'warn' : 'info',
      transport:
        process.env.NODE_ENV !== 'production'
          ? { target: 'pino-pretty' }
          : undefined,
    },
    bodyLimit: parseInt(process.env.API_BODY_LIMIT_BYTES ?? '1048576', 10),
    trustProxy: process.env.TRUST_PROXY === 'false' ? false : true,
    requestTimeout: parseInt(process.env.REQUEST_TIMEOUT_MS ?? '30000', 10),
    connectionTimeout: parseInt(process.env.CONNECTION_TIMEOUT_MS ?? '10000', 10),
    keepAliveTimeout: parseInt(process.env.KEEP_ALIVE_TIMEOUT_MS ?? '5000', 10),
  });

  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body)
  );

  await app.register(require('@fastify/helmet'), {
    contentSecurityPolicy: {
      defaultSrc: ["'none'"],
      frameSrc: ["'none'"],
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });

  await app.register(require('@fastify/cors'), {
    origin:
      process.env.NODE_ENV === 'production'
        ? (process.env.ALLOWED_ORIGINS || '').split(',')
        : /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/,
    credentials: true,
  });

  await app.register(require('@fastify/cookie'), {
    secret: process.env.COOKIE_SECRET,
    hook: 'onRequest',
  });
  app.decorate('setSessionCookie', function setSessionCookie(reply, rawId) {
    const isProduction = process.env.NODE_ENV === 'production';
    reply.setCookie('bsession', rawId, {
      httpOnly: true,
      sameSite: 'strict',
      secure: isProduction,
      path: '/',
      maxAge: parseInt(process.env.SESSION_MAX_AGE_DAYS ?? '30', 10) * 24 * 60 * 60,
    });
    return reply;
  });

  await app.register(require('@fastify/rate-limit'), {
    max: parseInt(process.env.API_RATE_LIMIT_PER_MINUTE ?? '120'),
    timeWindow: '1 minute',
    keyGenerator: (req) => req.userId || req.ip,
    errorResponseBuilder: (_req, context) => ({
      statusCode: context.ban ? 403 : 429,
      error: context.ban ? 'rate_limit_banned' : 'rate_limit_exceeded',
      message: 'Too many requests. Please slow down.',
    }),
  });

  // Compression handled by reverse proxy (NPM/Cloudflare)

  await app.register(require('./middleware/security'));
  await app.register(require('./middleware/subscription'));

  await app.register(require('./routes/auth'),        { prefix: '/auth' });
  await app.register(require('./routes/passkey'),     { prefix: '/auth' });
  await app.register(require('./routes/sso'),         { prefix: '/auth' });
  await app.register(require('./routes/quickconnect'),{ prefix: '/auth' });
  await app.register(require('./routes/commits'),     { prefix: '/commits' });
  await app.register(require('./routes/assets'),      { prefix: '/assets' });
  await app.register(require('./routes/snapshot'),    { prefix: '/snapshot' });
  await app.register(require('./routes/account'),     { prefix: '/account' });
  await app.register(require('./routes/plans'),       { prefix: '/plans' });
  await app.register(require('./routes/email'),      { prefix: '' });
  await app.register(require('./routes/collaboration'), { prefix: '/collaboration' });
  await app.register(require('./routes/workspaces'),   { prefix: '/workspaces' });
  await app.register(require('./routes/organizations'), { prefix: '/organizations' });
  await app.register(require('./routes/vault'),         { prefix: '/vault' });
  await app.register(require('./routes/yjs-sync'),     { prefix: '/yjs' });
  await app.register(require('./routes/sync-state'),   { prefix: '/sync' });
  await app.register(require('./routes/audit'),       { prefix: '/audit' });
  await app.register(require('./routes/admin'),       { prefix: '/admin' });
  await app.register(require('./routes/webhooks'),    { prefix: '/webhooks' });
  await app.register(require('./routes/comments'),    { prefix: '/comments' });
  await app.register(require('./routes/sso-admin'));

  await app.register(require('@fastify/websocket'));
  await app.register(require('./routes/ws'));

  app.get('/health', {
    config: {
      security: {
        public: true,
      },
      rateLimit: {
        max: parseInt(process.env.HEALTH_RATE_LIMIT_PER_MINUTE ?? '30', 10),
        timeWindow: '1 minute',
      },
    },
  }, async () => {
    const payload = {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };

    if (process.env.NODE_ENV !== 'production') {
      try {
        getDb();
        payload.db = 'connected';
      } catch {
        payload.db = 'disconnected';
      }
    }

    return payload;
  });

  app.setErrorHandler((err, req, reply) => {
    const statusCode =
      err.statusCode ??
      (err.error === 'rate_limit_exceeded' ? 429 : 500);
    const isProduction = process.env.NODE_ENV === 'production';
    const logLevel = statusCode >= 500 ? 'error' : statusCode >= 429 ? 'warn' : 'info';

    req.log[logLevel]({
      err: statusCode >= 500 ? err : undefined,
      code: err.code,
      statusCode,
      route: req.routeOptions?.url,
    }, 'Request failed');

    if (err.validation) {
      return reply.status(400).send({
        error: 'validation_error',
        message: 'Invalid request data.',
        ...(isProduction ? {} : { details: err.validation }),
      });
    }

    return reply.status(statusCode).send({
      error: err.code ?? err.error ?? 'internal_error',
      message: isProduction && statusCode >= 500
        ? 'An unexpected error occurred.'
        : (err.message ?? 'Request failed.'),
    });
  });

  return app;
}

async function start() {
  const app = await buildApp();

  const { ensureSchema } = require('./db/migrate-postgres');
  await ensureSchema();

  getDb();
  app.log.info('Database connected');

  try {
    const { ensureBucket } = require('./services/r2');
    await ensureBucket();
  } catch (err) {
    app.log.warn('Storage bucket check failed (non-fatal):', err.message);
  }

  try {
    const { startPostgresListener } = require('./lib/events');
    await startPostgresListener();
  } catch (err) {
    app.log.warn('Postgres listener start failed (non-fatal):', err.message);
  }

  const port = parseInt(process.env.PORT ?? '3000');
  const host = process.env.HOST ?? '0.0.0.0';

  await app.listen({ port, host });
  app.log.info(`Beaver Sync API running on http://${host}:${port}`);
}

if (require.main === module) {
  start().catch((err) => {
    console.error('Fatal startup error:', err);
    process.exit(1);
  });
}

module.exports = { buildApp, start };
