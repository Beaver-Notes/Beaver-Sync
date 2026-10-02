'use strict';

require('dotenv').config();

const Fastify = require('fastify');
const { getDb } = require('./db');
const { hashSessionId } = require('./lib/crypto');

// Crash-safety: a floating promise or thrown sync error must never vanish
// without a trace. uncaughtException exits (state is undefined); unhandledRejection
// logs loudly (Node's default already exits, this just makes it observable).
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException', { message: err?.message, stack: err?.stack });
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection', { reason: reason instanceof Error ? { message: reason.message, stack: reason.stack } : reason });
});

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
  requireVar('INTERNAL_API_SECRET', isProduction, 32);
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
      const msg = `${name} is using a default value. Generate a real key for production.`;
      if (isProduction) {
        console.error(`FATAL: ${msg}`);
        process.exit(1);
      }
      console.warn(`WARNING: ${msg}`);
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

// The limiter runs on the plugin default hook (onRequest), which fires before
// authenticate, so req.userId is never set here and the old `req.userId || req.ip`
// key silently collapsed to the IP: every account behind one NAT, CGNAT or corporate
// egress shared a bucket, so one client could lock out everyone else on that IP.
// Key on an HMAC of the presented credential instead. The token never reaches the
// rate-limit backend in the clear, and a caller with no credential still falls back
// to the IP, which is what a login-attempt limit wants anyway.
function rateLimitKey(req) {
  if (req.userId) return `u:${req.userId}`;
  const auth = req.headers?.authorization;
  const raw = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : req.cookies?.bsession;
  if (raw) return `c:${hashSessionId(`ratelimit:${raw}`)}`;
  return `ip:${req.ip}`;
}

async function buildApp() {
  const { initErrorMonitoring } = require('./lib/error-monitoring');
  initErrorMonitoring(process.env.GLITCHTIP_DSN);

  const mlkem = require('./lib/mlkem');
  await mlkem.init();

  // Enterprise license grace/expiry warnings (offline HMAC, 14d grace, seats soft-warn)
  if (process.env.ENTERPRISE_MODE === 'true') {
    try {
      const lic = require('./lib/license');
      const s = lic.getLicenseStatus();
      if (process.env.NODE_ENV === 'production' && !s.valid) {
        console.warn(`[license] ENTERPRISE_MODE=true but license invalid (${s.reason}) — enterprise features disabled`);
      } else if (s.valid && s.inGrace) {
        console.warn(`[license] license for ${s.payload.licensee} expired ${new Date(s.expiryMs).toISOString().slice(0,10)} — in ${lic.GRACE_DAYS}d grace (${s.graceDaysLeft}d left)`);
      } else if (s.valid && s.expiringSoon) {
        console.warn(`[license] license for ${s.payload.licensee} expires ${s.payload.expiry} — within ${lic.GRACE_DAYS}d grace window`);
      }
      if (s.valid && s.payload?.seats) {
        // soft-warn only; caller checks via checkSeats for actual usage
      }
    } catch {}
  }

  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === 'production' ? 'warn' : 'info',
      // pino-pretty's worker thread hangs node:test across sequential app builds
      transport:
        process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test'
          ? { target: 'pino-pretty' }
          : undefined,
    },
    bodyLimit: parseInt(process.env.API_BODY_LIMIT_BYTES ?? '1048576', 10),
    // Asset keys routinely exceed Fastify's default maxParamLength (100), which
    // would 414 `GET/PUT/DELETE /assets/:key`. The new-scheme key
    // (`assets--<ws>--<note>--<43-char hash>`) is already ~127 chars for two
    // UUIDs, and legacy item-3 opaque tokens run to ~900. 2048 covers every
    // legal key with margin, legacy included.
    routerOptions: {
      maxParamLength: parseInt(process.env.FASTIFY_MAX_PARAM_LENGTH ?? '2048', 10),
    },
    trustProxy: process.env.TRUST_PROXY === 'true' ? true : false,
    requestTimeout: parseInt(process.env.REQUEST_TIMEOUT_MS ?? '30000', 10),
    connectionTimeout: parseInt(process.env.CONNECTION_TIMEOUT_MS ?? '10000', 10),
    keepAliveTimeout: parseInt(process.env.KEEP_ALIVE_TIMEOUT_MS ?? '5000', 10),
  });

  // Fastify 5 400s empty JSON bodies; restore v4 behavior so bodyless requests pass
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (body === '' || body === undefined) return done(null, {});
    try {
      done(null, JSON.parse(body));
    } catch (err) {
      err.statusCode = 400;
      done(err, undefined);
    }
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

  let redisClient = null;
  if (process.env.REDIS_URL) {
    try {
      const Redis = require('ioredis');
      redisClient = new Redis(process.env.REDIS_URL, {
        connectTimeout: 2000,
        maxRetriesPerRequest: 2,
        enableReadyCheck: true,
        lazyConnect: false,
      });
      redisClient.on('error', (err) => app.log.warn({ err: err.message }, 'Redis rate-limit store error — falling back to in-memory'));
    } catch (err) {
      app.log.warn({ err: err.message }, 'REDIS_URL set but ioredis unavailable — using in-memory rate limiting');
    }
  }
  await app.register(require('@fastify/rate-limit'), {
    max: parseInt(process.env.API_RATE_LIMIT_PER_MINUTE ?? '120'),
    timeWindow: '1 minute',
    keyGenerator: rateLimitKey,
    ...(redisClient ? { redis: redisClient, nameSpace: 'beaver-ratelimit-', skipOnError: true } : {}),
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
  await app.register(require('./routes/billing'),     { prefix: '/billing' });
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
  await app.register(require('./routes/activity'),    { prefix: '/activity' });
  await app.register(require('./routes/sso-admin'));

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
  }, async (_req, reply) => {
    const payload = {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };

    try {
      const { query } = require('./db');
      await query('SELECT 1');
      payload.db = 'connected';
    } catch {
      payload.db = 'disconnected';
      payload.status = 'degraded';
      reply.status(503);
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

  // Scheduled YJS GC/compaction (D18) — env-toggled, advisory-locked
  try {
    const { startGcScheduler } = require('./jobs/yjs-gc');
    startGcScheduler(app);
  } catch (err) {
    app.log.warn({ err: err.message }, '[yjs-gc] scheduler init failed (non-fatal)');
  }

  // Scheduled orphan asset GC — separate job, env-toggled (off by default),
  // dry-run unless explicitly armed, advisory-locked.
  try {
    const { startAssetGcScheduler } = require('./jobs/asset-gc');
    startAssetGcScheduler(app);
  } catch (err) {
    app.log.warn({ err: err.message }, '[asset-gc] scheduler init failed (non-fatal)');
  }

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

  const port = parseInt(process.env.PORT ?? '3000');
  const host = process.env.HOST ?? '0.0.0.0';

  await app.listen({ port, host });
  app.log.info(`Beaver Sync API running on http://${host}:${port}`);

  // Graceful shutdown: flush in-flight requests, close DB pool
  let shuttingDown = false;
  async function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`Received ${signal} — shutting down gracefully`);
    try {
      await app.close();
    } catch (err) {
      app.log.warn({ err }, 'Error closing Fastify');
    }
    try {
      const { close } = require('./db');
      await close();
    } catch {}
    process.exit(0);
  }
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

if (require.main === module) {
  start().catch((err) => {
    console.error('Fatal startup error:', err);
    process.exit(1);
  });
}

module.exports = { buildApp, start };
