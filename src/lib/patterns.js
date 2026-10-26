'use strict';

const DEVICE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

// Labels older clients hardcoded and sent on every push. They must never
// overwrite a real model ("Pixel 9 · Android") captured from a newer client.
const PLACEHOLDER_DEVICE_LABELS = new Set([
  'Beaver Notes (Rust)',
  'Unknown Device',
]);

function isPlaceholderDeviceLabel(label) {
  return PLACEHOLDER_DEVICE_LABELS.has(String(label ?? '').trim());
}

module.exports = { DEVICE_ID_PATTERN, isPlaceholderDeviceLabel };
