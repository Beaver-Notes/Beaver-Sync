#!/usr/bin/env node
'use strict';

const { render, getLogoDataUri } = require('../src/email/renderer');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const logoUrl = getLogoDataUri();
const dashboardUrl = 'https://app.beavernotes.com';

const templates = [
  { name: 'welcome', data: { dashboardUrl, logoUrl } },
  { name: 'verify', data: { email: 'you@example.com', verifyUrl: 'https://app.beavernotes.com/verify?token=abc123', expiresIn: '1 hour', logoUrl } },
  { name: 'password-reset', data: { resetUrl: 'https://app.beavernotes.com/reset?token=xyz789', expiresIn: '1 hour', logoUrl } },
  { name: 'password-changed', data: { timestamp: 'August 5, 2026 at 10:30 AM', deviceInfo: 'Chrome on macOS', logoUrl } },
  { name: 'account-deleted', data: { timestamp: 'August 5, 2026', logoUrl } },
  { name: 'workspace-invite', data: { inviterName: 'Alice', workspaceName: 'Design Team', inviteUrl: 'https://app.beavernotes.com/join?token=inv123', expiresIn: '7 days', logoUrl } },
  { name: 'note-invite', data: { inviterName: 'Bob', noteTitle: 'Meeting Notes — Q3 Planning', inviteUrl: 'https://app.beavernotes.com/note?token=ninv456', expiresIn: '7 days', logoUrl } },
  { name: 'subscription-receipt', data: { plan: 'Basic', amount: '$5/mo', period: 'Monthly', dashboardUrl, logoUrl } },
];

const outDir = path.join(__dirname, '..', '.email-preview');
fs.mkdirSync(outDir, { recursive: true });

const indexHtml = [];

for (const { name, data } of templates) {
  const html = render(name, data);
  if (!html) {
    console.log(`  SKIP  ${name} (render returned null)`);
    continue;
  }
  const file = path.join(outDir, `${name}.html`);
  fs.writeFileSync(file, html);
  console.log(`  OK    ${name}.html (${(html.length / 1024).toFixed(1)} KB)`);
  indexHtml.push(`<li><a href="${name}.html">${name}</a></li`);
}

// Write an index page
const index = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Beaver Email Previews</title>
  <style>
    body { font-family: system-ui; max-width: 400px; margin: 60px auto; color: #1c1917; }
    h1 { font-size: 22px; }
    li { margin: 8px 0; }
    a { color: #f59e0b; text-decoration: none; font-weight: 600; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <h1>Beaver Email Previews</h1>
  <ul>${indexHtml.join('\n    ')}</ul>
</body>
</html>`;

fs.writeFileSync(path.join(outDir, 'index.html'), index);
console.log(`\nPreview: ${outDir}/index.html`);
console.log(`Opening in browser...`);

execSync(`open "${path.join(outDir, 'index.html')}"`);
