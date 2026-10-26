'use strict';

// `http(s)://tauri.localhost` is the WebView origin on Tauri Android and
// Windows; `tauri://localhost` is the desktop custom scheme. Every scheme is
// appended because @fastify/cors compares entries by strict equality against
// the Origin header, and operators fill ALLOWED_ORIGINS with web origins that
// cannot be relied on to carry every scheme.
const TAURI_ORIGINS = [
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
];

const DEV_ORIGIN_PATTERN = /^(https?:\/\/(localhost|127\.0\.0\.1|tauri\.localhost)(:\d+)?|tauri:\/\/localhost)$/;

function buildCorsOrigin({ nodeEnv = process.env.NODE_ENV, allowedOrigins = process.env.ALLOWED_ORIGINS } = {}) {
  if (nodeEnv !== 'production') return DEV_ORIGIN_PATTERN;

  return (allowedOrigins || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
    .concat(TAURI_ORIGINS);
}

module.exports = { buildCorsOrigin, TAURI_ORIGINS, DEV_ORIGIN_PATTERN };
