'use strict';

const crypto = require('crypto');

const SESSION_HMAC_KEY = process.env.SESSION_HMAC_KEY;
const EMAIL_HMAC_KEY = process.env.EMAIL_HMAC_KEY;
const NOTE_HMAC_KEY = process.env.NOTE_HMAC_KEY;

if (!SESSION_HMAC_KEY || SESSION_HMAC_KEY.length < 32) {
  console.error('❌ SESSION_HMAC_KEY is required and must be at least 32 characters');
  process.exit(1);
}

if (!EMAIL_HMAC_KEY || EMAIL_HMAC_KEY.length < 32) {
  console.error('❌ EMAIL_HMAC_KEY is required and must be at least 32 characters');
  process.exit(1);
}

function createEmailHash(email) {
  const normalized = String(email).trim().toLowerCase();
  return crypto.createHmac('sha256', EMAIL_HMAC_KEY).update(normalized).digest('hex');
}

function hashSessionId(rawId) {
  return crypto.createHmac('sha256', SESSION_HMAC_KEY).update(rawId).digest('hex');
}

function createNoteHash(noteId) {
  if (!NOTE_HMAC_KEY || NOTE_HMAC_KEY.length < 32) return null;
  return crypto.createHmac('sha256', NOTE_HMAC_KEY).update(noteId).digest('hex');
}

function hashAccountId(id) {
  return crypto.createHmac('sha256', SESSION_HMAC_KEY).update(id).digest('hex');
}

module.exports = {
  createEmailHash,
  hashSessionId,
  createNoteHash,
  hashAccountId,
};
