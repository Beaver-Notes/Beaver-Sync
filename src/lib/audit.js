'use strict';

const { AuditLog } = require('../models');
const mlkem = require('./mlkem');
const { hashAccountId } = require('./crypto');

function getIpSubnet(req) {
  const ip = req.ip ?? '0.0.0.0';
  if (ip.includes(':')) return ip.includes('::1') ? '::1' : ip.split(':').slice(0, 4).join(':');
  const parts = ip.split('.');
  return parts.slice(0, 3).join('.');
}

async function audit(req, action, meta = {}) {
  try {
    const metadataEncrypted = Object.keys(meta).length > 0
      ? await mlkem.encryptMetadata(JSON.stringify(meta))
      : null;

    await AuditLog.create({
      accountIdHash: hashAccountId(req.userId),
      workspaceId: meta.workspaceId ?? null,
      action,
      metadataEncrypted,
      ipSubnet: getIpSubnet(req),
      createdAt: new Date(),
    });
  } catch (err) {
    req.log?.error?.({ err, action }, 'Audit log write failed');
  }
}

module.exports = { audit };
