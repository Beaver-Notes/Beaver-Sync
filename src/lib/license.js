'use strict';

const crypto = require('crypto');

function isEnterpriseMode() {
  return process.env.ENTERPRISE_MODE === 'true';
}

function validateLicenseKey(workspaceId, licenseKey, expiresAt) {
  const secret = process.env.LICENSE_SECRET;
  if (!secret) return false;
  if (!workspaceId || !licenseKey || !expiresAt) return false;

  const expiry = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (!(expiry instanceof Date) || Number.isNaN(expiry.getTime())) return false;
  if (expiry.getTime() < Date.now()) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(workspaceId + (expiry instanceof Date ? expiry.toISOString() : expiresAt))
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(licenseKey, 'hex'),
      Buffer.from(expected, 'hex')
    );
  } catch {
    return false;
  }
}

function generateLicenseKey(workspaceId, expiresAt) {
  const secret = process.env.LICENSE_SECRET;
  if (!secret) return null;

  return crypto
    .createHmac('sha256', secret)
    .update(workspaceId + expiresAt)
    .digest('hex');
}

module.exports = { isEnterpriseMode, validateLicenseKey, generateLicenseKey };
