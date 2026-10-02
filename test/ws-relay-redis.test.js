'use strict';

// The relay is documented as horizontally scalable behind Redis
// (docs/deployment.md:69, `docker-compose scale ws-relay=2`). This suite pins the
// fan-out contract: one client edit crosses the bus once, and a replica that
// receives it delivers to its own clients without putting it back on the bus.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const repoRoot = path.resolve(__dirname, '..');
process.env.NODE_ENV = 'test';
const relayPath = path.join(repoRoot, 'src/ws-relay-redis.js');
const CHANNEL = 'beaver:ws-relay';

const broker = { messages: [], clients: [] };
class FakeRedis {
  constructor() { this.status = 'ready'; this.handlers = new Map(); broker.clients.push(this); }
  on(ev, fn) { this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), fn]); }
  async subscribe() { return 1; }
  async unsubscribe() { return 1; }
  disconnect() {}
  async publish(channel, message) { broker.messages.push({ channel, message }); return 1; }
}

function withFakeRedis(fn) {
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'ioredis') return FakeRedis;
    return original.call(this, request, parent, isMain);
  };
  try { return fn(); } finally { Module._load = original; }
}

// A replica stands in for src/ws-relay.js: init(rooms, broadcastToRoom). The stub
// records what broadcastToRoom was handed and, like the real one at ws-relay.js:110,
// republishes unless the broadcast is flagged as already having come off the bus.
function makeReplica() {
  delete require.cache[relayPath];
  const relay = require(relayPath);
  const calls = [];
  const rooms = new Map([['workspace:ws1:note:n1', { conns: [] }]]);
  const before = broker.clients.length;
  const handle = relay.init(rooms, (documentName, msg, excludeWs, fromRelay) => {
    if (!rooms.has(documentName)) return;
    calls.push({ documentName, fromRelay });
    if (!fromRelay) handle.publish(documentName, msg);
  });
  // init() constructs pub then sub; the sub is the one carrying the message handler.
  const sub = broker.clients[broker.clients.length - 1];
  return {
    relay, handle, calls,
    deliver(message) { for (const fn of sub.handlers.get('message') ?? []) fn(CHANNEL, message); },
    unused: before,
  };
}

test('a replica that receives a fan-out delivers locally and does not republish', () => {
  const prevRedis = process.env.REDIS_URL;
  process.env.REDIS_URL = 'redis://fake:6379';
  broker.messages.length = 0;

  try {
    withFakeRedis(() => {
      const source = makeReplica();
      const peer = makeReplica();

      // One client edit on the source replica.
      source.handle.publish('workspace:ws1:note:n1', Buffer.from([1, 2, 3]));
      assert.equal(broker.messages.length, 1, 'one edit must cross the bus once');
      assert.deepEqual(source.calls, [], 'the source must not deliver to itself');

      // The peer receives it exactly as Redis would.
      for (const { channel, message } of broker.messages) {
        if (channel !== CHANNEL) continue;
        peer.deliver(message);
      }

      assert.equal(peer.calls.length, 1, 'the peer must deliver to its own clients once');
      assert.equal(
        peer.calls[0].fromRelay, true,
        'ws-relay-redis.js must flag the broadcast as coming off the bus. Without the flag, '
        + 'ws-relay.js:110 republishes it under this replica\'s own origin, the self-filter at '
        + 'ws-relay-redis.js:35 can never match it, and the fan-out loops until the stack '
        + 'overflows inside the empty catch{}.');

      const afterDelivery = broker.messages.length;
      assert.equal(afterDelivery, 1, `receiving a fan-out must not put it back on the bus (got ${afterDelivery} messages)`);

      for (const r of [source, peer]) r.handle.close();
    });
  } finally {
    if (prevRedis === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = prevRedis;
  }
});
