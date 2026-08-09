'use strict';

const crypto = require('crypto');
const { createMlKem768 } = require('mlkem');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
// ML-KEM-768 public key is 1184 bytes; hex-encoded that is 2368 chars.
const MLKEM_PUBLIC_KEY_HEX_LENGTH = 1184 * 2;

async function wrapForRecipient(publicKeyHex, secretHex) {
  const instance = await createMlKem768();
  const pk = Buffer.from(publicKeyHex, 'hex');
  const [kemCt, sharedSecret] = await instance.encap(pk);

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(sharedSecret), iv);
  const ct = Buffer.concat([cipher.update(secretHex, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    kemCt: Buffer.from(kemCt).toString('base64'),
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
    tag: tag.toString('base64'),
  };
}

async function unwrapForRecipient(privateKeyHex, envelope) {
  const instance = await createMlKem768();
  const sk = Buffer.from(privateKeyHex, 'hex');
  const kemCt = Buffer.from(envelope.kemCt, 'base64');

  const sharedSecret = await instance.decap(kemCt, sk);

  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    Buffer.from(sharedSecret),
    Buffer.from(envelope.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ct, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function validatePublicKey(hex) {
  return (
    typeof hex === 'string' &&
    hex.length === MLKEM_PUBLIC_KEY_HEX_LENGTH &&
    /^[0-9a-f]+$/i.test(hex)
  );
}

module.exports = { wrapForRecipient, unwrapForRecipient, validatePublicKey };
