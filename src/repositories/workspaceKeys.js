'use strict';

const { query } = require('../db');

// Add-only per-device fan-out: never overwrites an existing envelope, so a
// key-holding member can re-wrap the workspace key for a newly-linked device
// without rotating (splitting) the workspace key. Legacy rows have
// device_id NULL and are never touched. Returns the number inserted.
async function addRecipientsIfAbsent(workspaceId, recipients) {
  const now = new Date().toISOString();
  let inserted = 0;
  for (const r of recipients) {
    const { rowCount } = await query(
      `INSERT INTO workspace_keys (workspace_id, user_id, device_id, wrapped_key, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (workspace_id, user_id, device_id) DO NOTHING`,
      [workspaceId, r.userId, r.deviceId || 'default', r.wrappedKey, now]
    );
    inserted += rowCount;
  }
  return inserted;
}

// Which (user, device) pairs already hold an envelope, for hasEnvelope flags.
async function listEnvelopes(workspaceId) {
  const { rows } = await query(
    'SELECT user_id, device_id, wrapped_key FROM workspace_keys WHERE workspace_id = $1',
    [workspaceId]
  );
  return rows;
}

// A member can hold several envelopes (one per device) plus the legacy
// account-level one (device_id NULL). Callers try them in order, so put the
// session's own device first, then the legacy envelope, then the rest.
function orderEnvelopes(envelopes, sessionDeviceId) {
  const rank = (e) => {
    if (sessionDeviceId && e.deviceId === sessionDeviceId) return 0;
    if (e.deviceId == null) return 1;
    return 2;
  };
  return [...envelopes].sort((a, b) => rank(a) - rank(b));
}

// Scalar `wrappedKey` is a convenience for older clients; newer ones use the
// `wrappedKeys` list. Never hand a caller a foreign device's envelope: return
// the session device's own envelope when present, else the legacy account-level
// one, else null so the client falls back to re-wrapping.
function selectScalarEnvelope(envelopes, sessionDeviceId) {
  const ordered = orderEnvelopes(envelopes, sessionDeviceId);
  const own = sessionDeviceId
    ? ordered.find((e) => e.deviceId === sessionDeviceId)
    : null;
  if (own) return own.wrappedKey;
  const legacy = ordered.find((e) => e.deviceId == null);
  return legacy ? legacy.wrappedKey : null;
}

module.exports = {
  addRecipientsIfAbsent,
  listEnvelopes,
  orderEnvelopes,
  selectScalarEnvelope,
};
