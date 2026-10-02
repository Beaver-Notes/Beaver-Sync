'use strict';

// Optional Redis pub/sub for ws-relay horizontal scaling.
// When REDIS_URL is set, Yjs sync/awareness broadcasts are fanned out
// across relay replicas. Single-instance deployments are unaffected
// (module returns null and relay falls back to in-memory broadcast).

let pub = null;
let sub = null;
let instanceId = null;

const CHANNEL = 'beaver:ws-relay';

function init(rooms, localBroadcast) {
  if (!process.env.REDIS_URL) return null;
  let Redis;
  try { Redis = require('ioredis'); } catch { return null; }
  instanceId = Math.random().toString(36).slice(2, 8);
  const opts = { connectTimeout: 2000, maxRetriesPerRequest: 1, enableReadyCheck: true, lazyConnect: false };
  try {
    pub = new Redis(process.env.REDIS_URL, opts);
    sub = new Redis(process.env.REDIS_URL, opts);
  } catch (err) {
    console.warn('[ws-relay-redis] failed to create clients:', err.message);
    return null;
  }
  pub.on('error', (err) => console.warn('[ws-relay-redis] pub error:', err.message));
  sub.on('error', (err) => console.warn('[ws-relay-redis] sub error:', err.message));

  sub.subscribe(CHANNEL).catch((err) => console.warn('[ws-relay-redis] subscribe failed:', err.message));
  sub.on('message', (channel, message) => {
    if (channel !== CHANNEL) return;
    try {
      const { documentName, payload, origin } = JSON.parse(message);
      if (origin === instanceId) return; // already broadcast locally on origin
      if (!documentName || !payload) return;
      const buf = Buffer.from(payload, 'base64');
      // remote instance already broadcast locally via localBroadcast; just fan out here
      const u8 = new Uint8Array(buf);
      localBroadcast(documentName, u8, null, true);
    } catch {}
  });

  if (process.env.NODE_ENV !== 'production') {
    console.log(`[ws-relay-redis] enabled channel=${CHANNEL} id=${instanceId}`);
  }

  return {
    publish(documentName, payload) {
      if (!pub || pub.status !== 'ready') return;
      try {
        const msg = JSON.stringify({
          documentName,
          payload: Buffer.from(payload).toString('base64'),
          origin: instanceId,
        });
        pub.publish(CHANNEL, msg).catch(() => {});
      } catch {}
    },
    async close() {
      try { await sub.unsubscribe(CHANNEL); } catch {}
      try { sub.disconnect(); } catch {}
      try { pub.disconnect(); } catch {}
      pub = sub = null;
    },
  };
}

module.exports = { init };
