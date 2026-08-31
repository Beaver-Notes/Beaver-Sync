'use strict';

const crypto = require('crypto');

const GRACE_DAYS = 14;
const GRACE_MS = GRACE_DAYS * 24 * 60 * 60 * 1000;
const PREFIX = 'BL';

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64url');
}

function b64urlDecode(str) {
  return Buffer.from(str, 'base64url');
}

function canonicalStringify(obj) {
  const sortedKeys = Object.keys(obj).sort();
  const sorted = {};
  for (const k of sortedKeys) sorted[k] = obj[k];
  return JSON.stringify(sorted);
}

function getLicenseSecret() {
  return process.env.LICENSE_SECRET || '';
}

function getLicenseKey() {
  return process.env.LICENSE_KEY || process.env.BEAVER_LICENSE || process.env.LICENSE || '';
}

function createLicensePayload({ licensee, plan = 'enterprise', seats, expiry }) {
  const payload = { licensee, plan, expiry };
  if (seats !== undefined && seats !== null) payload.seats = seats;
  // strip undefined
  for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];
  return payload;
}

function signPayloadB64(payloadB64) {
  const secret = getLicenseSecret();
  if (!secret) throw new Error('LICENSE_SECRET not set');
  return b64urlEncode(crypto.createHmac('sha256', secret).update(payloadB64).digest());
}

function generateLicenseKey({ licensee, seats, expiry, plan = 'enterprise' }) {
  if (!licensee || typeof licensee !== 'string') throw new Error('licensee required');
  if (plan !== 'enterprise') throw new Error('plan must be enterprise');
  if (!expiry) throw new Error('expiry required');
  const payload = createLicensePayload({ licensee, plan, seats, expiry });
  const json = canonicalStringify(payload);
  const payloadB64 = b64urlEncode(json);
  const sigB64 = signPayloadB64(payloadB64);
  return `${PREFIX}${payloadB64}.${sigB64}`;
}

function verifyLicense(key) {
  if (!key || typeof key !== 'string') return { valid: false, reason: 'missing' };
  if (!key.startsWith(PREFIX)) return { valid: false, reason: 'bad_prefix' };
  const rest = key.slice(PREFIX.length);
  const dot = rest.indexOf('.');
  if (dot === -1) return { valid: false, reason: 'bad_format' };
  const payloadB64 = rest.slice(0, dot);
  const sigB64 = rest.slice(dot + 1);
  if (!payloadB64 || !sigB64) return { valid: false, reason: 'bad_format' };

  let sigBuf;
  let payloadBuf;
  try {
    sigBuf = b64urlDecode(sigB64);
    payloadBuf = b64urlDecode(payloadB64);
  } catch {
    return { valid: false, reason: 'bad_encoding' };
  }

  const secret = getLicenseSecret();
  if (!secret) return { valid: false, reason: 'no_secret' };

  const expected = crypto.createHmac('sha256', secret).update(payloadB64).digest();
  if (expected.length !== sigBuf.length) return { valid: false, reason: 'bad_signature' };
  if (!crypto.timingSafeEqual(expected, sigBuf)) return { valid: false, reason: 'bad_signature' };

  let payload;
  try {
    const jsonStr = payloadBuf.toString('utf8');
    payload = JSON.parse(jsonStr);
  } catch {
    return { valid: false, reason: 'bad_payload' };
  }

  if (!payload.licensee || typeof payload.licensee !== 'string' || !payload.licensee.trim()) {
    return { valid: false, reason: 'bad_licensee', payload };
  }
  if (payload.plan !== 'enterprise') {
    return { valid: false, reason: 'bad_plan', payload };
  }
  if (payload.seats !== undefined) {
    if (!Number.isInteger(payload.seats) || payload.seats <= 0) {
      return { valid: false, reason: 'bad_seats', payload };
    }
  }
  if (!payload.expiry || typeof payload.expiry !== 'string') {
    return { valid: false, reason: 'missing_expiry', payload };
  }
  const expiryMs = Date.parse(payload.expiry);
  if (Number.isNaN(expiryMs)) {
    return { valid: false, reason: 'bad_expiry', payload };
  }

  const now = Date.now();
  const graceEndMs = expiryMs + GRACE_MS;
  if (now > graceEndMs) {
    return { valid: false, reason: 'expired', expired: true, payload, expiryMs, graceEndMs };
  }
  const inGrace = now > expiryMs;
  const expiringSoon = !inGrace && expiryMs - now <= GRACE_MS;
  // seats is soft-warn only; caller checks via checkSeats
  return {
    valid: true,
    payload,
    expiryMs,
    graceEndMs,
    inGrace,
    expiringSoon,
    graceDaysLeft: inGrace ? Math.ceil((graceEndMs - now) / (24 * 60 * 60 * 1000)) : null,
    daysUntilExpiry: Math.ceil((expiryMs - now) / (24 * 60 * 60 * 1000)),
  };
}

function getLicenseStatus() {
  const key = getLicenseKey();
  if (!key) return { valid: false, reason: 'missing', payload: null };
  return verifyLicense(key);
}

function isEnterpriseMode() {
  if (process.env.ENTERPRISE_MODE !== 'true') return false;
  if (process.env.NODE_ENV !== 'production') return true;
  // production: valid license required
  const s = getLicenseStatus();
  return s.valid;
}

function checkSeats(usedSeats) {
  const status = getLicenseStatus();
  if (!status.valid || !status.payload) return { warn: false, reason: 'no_license' };
  const licensedSeats = status.payload.seats;
  if (licensedSeats === undefined || licensedSeats === null) return { warn: false, reason: 'unlimited' };
  const used = Number(usedSeats) || 0;
  if (used > licensedSeats) {
    return { warn: true, licensedSeats, usedSeats: used, message: `Seat limit exceeded: ${used} used, ${licensedSeats} licensed (soft limit)` };
  }
  return { warn: false, licensedSeats, usedSeats: used };
}

module.exports = {
  GRACE_DAYS,
  GRACE_MS,
  PREFIX,
  b64urlEncode,
  b64urlDecode,
  canonicalStringify,
  generateLicenseKey,
  verifyLicense,
  getLicenseStatus,
  getLicenseKey,
  getLicenseSecret,
  isEnterpriseMode,
  checkSeats,
};
