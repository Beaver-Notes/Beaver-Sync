'use strict';

const { AuditLog } = require('../models');
const mlkem = require('./mlkem');
const { hashSessionId } = require('./crypto');

function getIpSubnet(req) {
  const ip = req.ip ?? '0.0.0.0';
  if (ip.includes(':')) return ip.includes('::1') ? '::1' : ip.split(':').slice(0, 4).join(':');
  const parts = ip.split('.');
  return parts.slice(0, 3).join('.');
}

function audit(req, action, meta = {}) {
  // Audit writes are off the critical path: defer so they never block the
  // request response (audit runs on every push/commit/login).
  const write = async () => {
    try {
      const metadataEncrypted = Object.keys(meta).length > 0
        ? await mlkem.encryptMetadata(JSON.stringify(meta))
        : null;

      await AuditLog.create({
        accountIdHash: hashSessionId(req.userId),
        workspaceId: meta.workspaceId ?? null,
        action,
        metadataEncrypted,
        ipSubnet: getIpSubnet(req),
        createdAt: new Date(),
      });
    } catch (err) {
      req.log?.error?.({ err, action }, 'Audit log write failed');
    }
  };

  setImmediate(write);
}

module.exports = { audit, getIpSubnet };
