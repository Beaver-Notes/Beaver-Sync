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
