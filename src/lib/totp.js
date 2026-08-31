'use strict';
const crypto = require('crypto');

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const B32_MAP = {};
for (let i = 0; i < B32_ALPHABET.length; i++) B32_MAP[B32_ALPHABET[i]] = i;

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out; // no padding
}

function base32Decode(str) {
  const s = String(str).trim().replace(/=+$/g, '').toUpperCase().replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    const v = B32_MAP[s[i]];
    if (v === undefined) throw new Error(`Invalid base32 character: ${s[i]}`);
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function hotp(secretBase32, counter) {
  const key = base32Decode(secretBase32);
  const counterBuf = Buffer.alloc(8);
  // 64-bit big-endian
  counterBuf.writeBigUInt64BE(BigInt(counter), 0);
  const hmac = crypto.createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  const otp = code % 1000000;
  return String(otp).padStart(6, '0');
}

function totpVerify(secretBase32, token, window = 1, nowSec = Math.floor(Date.now() / 1000)) {
  const t = String(token).trim();
  if (!/^\d{6}$/.test(t)) return null;
  const step = 30;
  const current = Math.floor(nowSec / step);
  for (let d = -window; d <= window; d++) {
    const counter = current + d;
    const expected = hotp(secretBase32, counter);
    const a = Buffer.from(expected);
    const b = Buffer.from(t);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return counter;
    }
  }
  return null;
}

function generateSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

function buildOtpauthUrl(secretBase32, label, issuer = 'Beaver Notes') {
  const encLabel = encodeURIComponent(`${issuer}:${label}`);
  const encIssuer = encodeURIComponent(issuer);
  return `otpauth://totp/${encLabel}?secret=${secretBase32}&issuer=${encIssuer}&algorithm=SHA1&digits=6&period=30`;
}

module.exports = { base32Encode, base32Decode, hotp, totpVerify, generateSecret, buildOtpauthUrl };
