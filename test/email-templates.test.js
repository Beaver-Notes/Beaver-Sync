'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const repoRoot = path.resolve(__dirname, '..');

test('render returns HTML string for valid template', () => {
  const { render } = require('../src/email/renderer');
  const html = render('welcome', { dashboardUrl: 'https://example.com', logoUrl: 'data:image/png;base64,abc' });
  assert.ok(typeof html === 'string', 'should return a string');
  assert.ok(html.length > 100, 'should have content');
  assert.ok(html.includes('Welcome'), 'should contain welcome text');
});

test('render returns null for missing template', () => {
  const { render } = require('../src/email/renderer');
  const html = render('nonexistent', {});
  assert.equal(html, null);
});

test('getLogoDataUri returns data URI string', () => {
  const { getLogoDataUri } = require('../src/email/renderer');
  const uri = getLogoDataUri();
  assert.ok(typeof uri === 'string', 'should return a string');
  assert.ok(uri.startsWith('data:image/png;base64,'), 'should be a data URI');
});

// --- Sender API tests ---

test('welcome template renders with correct content', async () => {
  const { render, getLogoDataUri } = require('../src/email/renderer');
  const html = render('welcome', {
    dashboardUrl: 'https://app.beavernotes.com',
    logoUrl: getLogoDataUri(),
  });
  assert.ok(html.includes('Welcome aboard'), 'should contain welcome heading');
  assert.ok(html.includes('btn-primary'), 'should have CTA button');
  assert.ok(html.includes('beavernotes.com'), 'should have footer link');
});

test('all templates render without errors', () => {
  const { render, getLogoDataUri } = require('../src/email/renderer');
  const logoUrl = getLogoDataUri();
  const templates = [
    { name: 'welcome', data: { dashboardUrl: 'https://example.com', logoUrl } },
    { name: 'verify', data: { email: 'test@example.com', verifyUrl: 'https://example.com/verify', expiresIn: '1 hour', logoUrl } },
    { name: 'password-reset', data: { resetUrl: 'https://example.com/reset', expiresIn: '1 hour', logoUrl } },
    { name: 'password-changed', data: { timestamp: '2026-01-01', deviceInfo: 'Chrome on macOS', logoUrl } },
    { name: 'account-deleted', data: { timestamp: '2026-01-01', logoUrl } },
    { name: 'workspace-invite', data: { inviterName: 'Alice', workspaceName: 'My Workspace', inviteUrl: 'https://example.com/join', expiresIn: '7 days', logoUrl } },
    { name: 'note-invite', data: { inviterName: 'Alice', noteTitle: 'My Note', inviteUrl: 'https://example.com/note', expiresIn: '7 days', logoUrl } },
    { name: 'subscription-receipt', data: { plan: 'Basic', amount: '$5/mo', period: 'Monthly', dashboardUrl: 'https://example.com', logoUrl } },
  ];

  for (const { name, data } of templates) {
    const html = render(name, data);
    assert.ok(html, `${name} should render`);
    assert.ok(html.includes('email-card'), `${name} should contain email-card class`);
    assert.ok(html.includes('f59e0b'), `${name} should contain amber accent`);
  }
});
