'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createMlKem768 } = require('mlkem');
const {
  wrapForRecipient,
  unwrapForRecipient,
  validatePublicKey,
} = require('../src/lib/recipient-wrap');

function hexEncode(buf) {
  return Buffer.from(buf).toString('hex');
}

test('round-trips a secret between two keypairs', async () => {
  const alice = await createMlKem768();
  const bob = await createMlKem768();
  const [alicePk, aliceSk] = alice.generateKeyPair();
  const [, bobSk] = bob.generateKeyPair();

  const secret = Buffer.from(crypto.randomBytes(32)).toString('hex');
  const envelope = await wrapForRecipient(hexEncode(alicePk), secret);
  const recovered = await unwrapForRecipient(hexEncode(aliceSk), envelope);

  assert.equal(recovered, secret);
  // bob cannot decrypt alice's envelope
  await assert.rejects(unwrapForRecipient(hexEncode(bobSk), envelope));
});

test('rejects malformed public keys', () => {
  assert.equal(validatePublicKey('zzz'), false);
  assert.equal(validatePublicKey(''), false);
  assert.equal(validatePublicKey('00'.repeat(32)), false);
  assert.equal(validatePublicKey('00'.repeat(1184)), true);
});
