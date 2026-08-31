'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
process.env.NODE_ENV = 'test';
process.env.JWT_PRIVATE_KEY_PATH = path.join(repoRoot, 'keys/private.pem');
process.env.JWT_PUBLIC_KEY_PATH = path.join(repoRoot, 'keys/public.pem');
process.env.COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars-long-e2e';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long-e2e';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-characters-long-e2e';
process.env.EMAIL_ENABLED = 'false';

const { render } = require('../src/email/renderer');

test('workspace invite template renders inviteUrl + workspaceName + expiresIn', () => {
  const html = render('workspace-invite', {
    inviterName: 'Alice',
    workspaceName: 'Design Team',
    inviteUrl: 'beaver-notes://join/abc123',
    expiresIn: '7 days',
  });
  assert.ok(html.includes('beaver-notes://join/abc123'));
  assert.ok(html.includes('Design Team'));
  assert.ok(html.includes('7 days'));
});

test('note invite template renders inviteUrl + noteTitle + expiresIn', () => {
  const html = render('note-invite', {
    inviterName: 'Bob',
    noteTitle: 'Q3 Planning',
    inviteUrl: 'beaver-notes://join/xyz789',
    expiresIn: '7 days',
  });
  assert.ok(html.includes('beaver-notes://join/xyz789'));
  assert.ok(html.includes('Q3 Planning'));
  assert.ok(html.includes('7 days'));
});
