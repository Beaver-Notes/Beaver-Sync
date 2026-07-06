'use strict';

const fp = require('fastify-plugin');

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const CSRF_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function normalizeContentType(headerValue) {
  return String(headerValue ?? '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
}

function safeInt(value) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function createMetrics() {
  const counters = new Map();

  return {
    increment(name, amount = 1) {
      counters.set(name, (counters.get(name) ?? 0) + amount);
    },
    snapshot() {
      return Object.fromEntries(counters.entries());
    },
  };
}

async function securityPlugin(app) {
  const metrics = createMetrics();

  app.decorate('securityMetrics', metrics);
  app.decorate('recordSecurityEvent', function recordSecurityEvent(req, name, details = {}) {
    metrics.increment(`security.${name}`);
    req.securityEvents ??= [];
    req.securityEvents.push(name);

    req.log.warn({
      requestId: req.id,
      event: name,
      route: req.routeOptions?.url,
      userId: req.userId ?? null,
      ip: req.ip,
      ...details,
    }, 'Security event');
  });

  app.addHook('onRequest', async (req, reply) => {
    req.requestStartNs = process.hrtime.bigint();
    req.securityEvents = [];
    reply.header('Cache-Control', 'no-store');
  });

  app.addHook('preValidation', async (req, reply) => {
    const security = req.routeOptions?.config?.security;
    const isBodyMethod = BODY_METHODS.has(req.method);

    if (isBodyMethod && CSRF_METHODS.has(req.method) && req.headers['authorization'] === undefined) {
      const cookie = req.cookies?.bsession;
      if (cookie) {
        const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
        const isProduction = process.env.NODE_ENV === 'production';
        const fetchSite = req.headers['sec-fetch-site'];
        const origin = req.headers['origin'];

        if (isProduction) {
          const sameOrigin = fetchSite === 'same-origin' || fetchSite === 'none';
          const originOk = origin && allowedOrigins.length > 0 && allowedOrigins.includes(origin);
          if (!sameOrigin && !originOk) {
            metrics.increment('security.csrf_rejected');
            return reply.status(403).send({
              error: 'csrf_validation_failed',
              message: 'Cross-origin state-changing requests are not permitted without a Bearer token.',
            });
          }
        } else if (origin && allowedOrigins.length > 0 && !allowedOrigins.includes(origin)) {
          metrics.increment('security.csrf_rejected');
          return reply.status(403).send({
            error: 'csrf_validation_failed',
            message: 'Cross-origin state-changing requests are not permitted without a Bearer token.',
          });
        }
      }
    }

    if (!security || !isBodyMethod) {
      return;
    }

    const contentLength = safeInt(req.headers['content-length']);
    const hasBody =
      contentLength !== null ||
      req.headers['transfer-encoding'] !== undefined ||
      req.body !== undefined;

    if (security.requireContentLength && contentLength === null) {
      metrics.increment('security.length_required');
      return reply.status(411).send({
        error: 'length_required',
        message: 'Content-Length header is required.',
      });
    }

    if (security.maxContentLength && contentLength !== null && contentLength > security.maxContentLength) {
      metrics.increment('security.oversized_request');
      return reply.status(413).send({
        error: 'payload_too_large',
        message: 'Request body is too large.',
      });
    }

    if (!hasBody || !security.allowedContentTypes?.length) {
      return;
    }

    const contentType = normalizeContentType(req.headers['content-type']);
    if (!security.allowedContentTypes.includes(contentType)) {
      metrics.increment('security.invalid_content_type');
      return reply.status(415).send({
        error: 'unsupported_media_type',
        message: `Content-Type must be one of: ${security.allowedContentTypes.join(', ')}.`,
      });
    }
  });

  app.setNotFoundHandler((req, reply) => {
    req.log.info({
      requestId: req.id,
      method: req.method,
      url: req.url,
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    }, 'Route not found');

    return reply.status(404).send({
      error: 'not_found',
      message: 'Route not found.',
    });
  });

  app.addHook('onResponse', async (req, reply) => {
    const latencyMs = req.requestStartNs
      ? Number(process.hrtime.bigint() - req.requestStartNs) / 1_000_000
      : null;
    const statusCode = reply.statusCode;
    const rateLimitResult = statusCode === 429 ? 'throttled' : 'ok';

    metrics.increment(`http.${statusCode}`);

    if ([401, 403, 404, 413, 429].includes(statusCode)) {
      metrics.increment(`security.status.${statusCode}`);
    }

    const logPayload = {
      requestId: req.id,
      endpoint: req.routeOptions?.url ?? req.url,
      method: req.method,
      statusCode,
      latencyMs,
      authResult: req.authResult ?? (req.userId ? 'authenticated' : 'anonymous'),
      principalId: req.userId ?? null,
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
      bytesIn: safeInt(req.headers['content-length']) ?? 0,
      bytesOut: safeInt(reply.getHeader('content-length')) ?? 0,
      rateLimitResult,
      securityEvents: req.securityEvents,
    };

    if (statusCode >= 500) {
      req.log.error(logPayload, 'Request completed');
      return;
    }

    if (statusCode >= 400) {
      req.log.warn(logPayload, 'Request completed');
      return;
    }

    req.log.info(logPayload, 'Request completed');
  });
}

module.exports = fp(securityPlugin);
