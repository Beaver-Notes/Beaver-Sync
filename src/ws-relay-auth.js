'use strict';

// Outbound auth calls from the relay to the main API backend.

const AUTH_BACKEND_URL = process.env.AUTH_BACKEND_URL ?? 'https://beaver-sync.internal:3000';
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;

async function verifySession(token, workspaceId, noteId) {
  const headers = { 'Content-Type': 'application/json' };
  if (INTERNAL_API_SECRET) {
    headers['X-Internal-Secret'] = INTERNAL_API_SECRET;
  }
  const body = { token, workspaceId };
  if (noteId) body.noteId = noteId;

  const response = await fetch(`${AUTH_BACKEND_URL}/auth/verify-session`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    // Bound the auth call so a hung backend can't leave the upgrade socket
    // open indefinitely (connection-exhaustion DoS surface).
    signal: AbortSignal.timeout(Number(process.env.WS_RELAY_AUTH_TIMEOUT_MS ?? 10000)),
  });

  if (response.status === 403) {
    throw new Error('Not a member of this workspace');
  }
  if (!response.ok) {
    throw new Error('Invalid or expired session token');
  }

  return response.json();
}

async function verifyTicket(ticket) {
  const headers = { 'Content-Type': 'application/json' };
  if (INTERNAL_API_SECRET) {
    headers['X-Internal-Secret'] = INTERNAL_API_SECRET;
  }
  const response = await fetch(`${AUTH_BACKEND_URL}/auth/verify-ticket`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ticket }),
    signal: AbortSignal.timeout(Number(process.env.WS_RELAY_AUTH_TIMEOUT_MS ?? 10000)),
  });
  if (!response.ok) {
    throw new Error('Invalid or expired ticket');
  }
  return response.json();
}

module.exports = { verifySession, verifyTicket };
