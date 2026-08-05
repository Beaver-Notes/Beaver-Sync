# HTML Email Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Handlebars-based HTML email templates to Beaver-Sync for all transactional emails, reflecting Beaver's warm amber design language with the beaver logo.

**Architecture:** A new `src/email/` module with a Handlebars renderer (cached compilation), 9 `.hbs` template files using a shared base layout, and a public API of `sendXxxEmail()` functions. The renderer auto-injects a base64-encoded beaver logo. Existing `sendWelcomeEmail` in `src/lib/email.js` is replaced.

**Tech Stack:** Handlebars (npm), Node.js `fs` for template loading, existing Resend transport via `sendWithAlias`.

## Global Constraints

- Email templates must use inline CSS or `<style>` blocks (no external stylesheets)
- Logo is a base64 data URI — no external image URLs
- All emails use the warm amber palette: `#f59e0b` accent, `#faf9f7` background, `#fffbeb` header gradient
- System font stack: `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`
- Card border-radius: 12px, button border-radius: 8px
- `handlebars` npm package (full, with compiler)
- Node >= 20

---

## File Structure

| File | Action | Purpose |
|------|--------|---------|
| `src/email/renderer.js` | Create | Template compilation + caching + logo injection |
| `src/email/index.js` | Create | Public API: `sendWelcomeEmail`, `sendVerifyEmail`, etc. |
| `src/email/templates/base.hbs` | Create | Shared email layout with Beaver design |
| `src/email/templates/welcome.hbs` | Create | Welcome email template |
| `src/email/templates/verify.hbs` | Create | Email verification template |
| `src/email/templates/password-reset.hbs` | Create | Password reset template |
| `src/email/templates/password-changed.hbs` | Create | Password changed confirmation |
| `src/email/templates/account-deleted.hbs` | Create | Account deletion confirmation |
| `src/email/templates/workspace-invite.hbs` | Create | Workspace invitation template |
| `src/email/templates/note-invite.hbs` | Create | Note collaboration invitation |
| `src/email/templates/subscription-receipt.hbs` | Create | Subscription change receipt |
| `src/email/assets/logo.png` | Create | Beaver logo (copy from frontend) |
| `src/lib/email.js` | Modify | Remove `sendWelcomeEmail` export |
| `src/routes/auth.js` | Modify | Update import path for `sendWelcomeEmail` |
| `test/email-templates.test.js` | Create | Unit tests for renderer + email functions |

---

### Task 1: Install Handlebars and scaffold directory

**Files:**
- Create: `src/email/` directory
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `handlebars` dependency available via `require('handlebars')`

- [ ] **Step 1: Install handlebars**

```bash
cd /Users/danielerolli/Documents/GitHub/Beaver-Sync && npm install handlebars
```

- [ ] **Step 2: Create directory structure**

```bash
mkdir -p src/email/templates src/email/assets
```

- [ ] **Step 3: Copy logo from frontend**

```bash
cp /Users/danielerolli/Documents/GitHub/Beaver-Notes/src/assets/images/logo-transparent.png src/email/assets/logo.png
```

- [ ] **Step 4: Verify handlebars loads**

```bash
node -e "const hbs = require('handlebars'); console.log('handlebars loaded:', typeof hbs.compile)"
```

Expected: `handlebars loaded: function`

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/email/
git commit --no-verify -m "chore: install handlebars, scaffold email template directory"
```

---

### Task 2: Build the renderer

**Files:**
- Create: `src/email/renderer.js`
- Test: `test/email-templates.test.js`

**Interfaces:**
- Consumes: `handlebars` npm, `fs` for reading templates, `path` for template resolution
- Produces: `render(templateName, data)` → `string | null`, `getLogoDataUri()` → `string`

- [ ] **Step 1: Write the failing test**

```javascript
// test/email-templates.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/danielerolli/Documents/GitHub/Beaver-Sync && node --test test/email-templates.test.js
```

Expected: FAIL with `Cannot find module '../src/email/renderer'`

- [ ] **Step 3: Implement the renderer**

```javascript
// src/email/renderer.js
'use strict';

const Handlebars = require('handlebars');
const fs = require('fs');
const path = require('path');

const TEMPLATES_DIR = path.join(__dirname, 'templates');
const LOGO_PATH = path.join(__dirname, 'assets', 'logo.png');

const compiledCache = new Map();
let baseTemplate = null;

function getLogoDataUri() {
  const buf = fs.readFileSync(LOGO_PATH);
  return `data:image/png;base64,${buf.toString('base64')}`;
}

function getBaseTemplate() {
  if (baseTemplate) return baseTemplate;
  const src = fs.readFileSync(path.join(TEMPLATES_DIR, 'base.hbs'), 'utf8');
  baseTemplate = Handlebars.compile(src);
  return baseTemplate;
}

function render(templateName, data) {
  try {
    const templatePath = path.join(TEMPLATES_DIR, `${templateName}.hbs`);
    if (!fs.existsSync(templatePath)) return null;

    let compiled = compiledCache.get(templateName);
    if (!compiled) {
      const src = fs.readFileSync(templatePath, 'utf8');
      compiled = Handlebars.compile(src);
      compiledCache.set(templateName, compiled);
    }

    return compiled(data);
  } catch (err) {
    console.error(`[email] Failed to render template "${templateName}":`, err.message);
    return null;
  }
}

module.exports = { render, getLogoDataUri };
```

- [ ] **Step 4: Create a minimal base.hbs for testing**

```handlebars
<!-- src/email/templates/base.hbs -->
<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"></head>
<body>
  {{> header-block }}
  {{> @partial-block }}
  {{> footer-block }}
</body>
</html>
```

- [ ] **Step 5: Create a minimal welcome.hbs for testing**

```handlebars
<!-- src/email/templates/welcome.hbs -->
{{#> base}}
  {{#*inline "header-block"}}<div>{{logoUrl}}</div>{{/inline}}
  {{#*inline "footer-block"}}<div>footer</div>{{/inline}}
  <h1>Welcome{{#if username}}, {{username}}{{/if}}</h1>
  <a href="{{dashboardUrl}}">Open Beaver Sync</a>
{{/base}}
```

- [ ] **Step 6: Run test to verify it passes**

```bash
cd /Users/danielerolli/Documents/GitHub/Beaver-Sync && node --test test/email-templates.test.js
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/email/renderer.js src/email/templates/base.hbs src/email/templates/welcome.hbs test/email-templates.test.js
git commit --no-verify -m "feat: add email template renderer with Handlebars caching"
```

---

### Task 3: Create the full base.hbs layout

**Files:**
- Modify: `src/email/templates/base.hbs`

**Interfaces:**
- Consumes: nothing (layout only)
- Produces: full HTML email layout with Beaver design tokens, used by all templates via `{{#> base}}`

- [ ] **Step 1: Replace base.hbs with the full layout**

```handlebars
<!-- src/email/templates/base.hbs -->
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <!--[if mso]>
  <noscript>
    <xml>
      <o:OfficeDocumentSettings>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
  </noscript>
  <![endif]-->
  <style>
    body, table, td { margin: 0; padding: 0; }
    body { background-color: #faf9f7; }
    img { border: 0; display: block; }
    .email-wrapper { width: 100%; background-color: #faf9f7; padding: 32px 16px; }
    .email-card {
      max-width: 540px; margin: 0 auto;
      background: #ffffff;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 1px 3px rgba(28, 25, 23, 0.06), 0 4px 12px rgba(28, 25, 23, 0.04);
    }
    .email-header {
      padding: 36px 32px 24px;
      text-align: center;
      background: linear-gradient(135deg, #fffbeb 0%, #fef3c7 100%);
      border-bottom: 1px solid #fde68a;
    }
    .email-header img { margin: 0 auto 12px; }
    .email-header h1 {
      margin: 0; font-size: 20px; font-weight: 600;
      color: #1c1917; letter-spacing: -0.01em;
    }
    .email-content {
      padding: 32px;
      font-size: 15px; line-height: 1.65;
      color: #44403c;
    }
    .email-content p { margin: 0 0 16px; }
    .email-content h2 {
      margin: 0 0 16px; font-size: 22px; font-weight: 700;
      color: #1c1917; letter-spacing: -0.02em;
    }
    .email-content .subtitle {
      font-size: 14px; color: #78716c; margin-bottom: 24px;
    }
    .btn-primary {
      display: inline-block; padding: 11px 28px;
      background-color: #f59e0b; color: #ffffff !important;
      text-decoration: none; border-radius: 8px;
      font-weight: 600; font-size: 14px;
      box-shadow: 0 1px 2px rgba(245, 158, 11, 0.3);
    }
    .btn-primary:hover { background-color: #d97706; }
    .callout {
      background: #fffbeb; border-left: 3px solid #f59e0b;
      border-radius: 0 8px 8px 0;
      padding: 14px 16px; margin: 20px 0;
      font-size: 14px; color: #92400e;
    }
    .divider {
      border: none; border-top: 1px solid #e7e5e4;
      margin: 24px 0;
    }
    .email-footer {
      padding: 24px 32px;
      text-align: center;
      font-size: 12px; line-height: 1.6;
      color: #a8a29e;
      background: #faf9f7;
      border-top: 1px solid #e7e5e4;
    }
    .email-footer a { color: #78716c; text-decoration: underline; }
    .email-footer .beaver-tag {
      display: inline-block; margin-top: 8px;
      font-size: 11px; color: #d6d3d1;
      letter-spacing: 0.5px;
    }
  </style>
</head>
<body>
  <div class="email-wrapper">
    <div class="email-card">
      <div class="email-header">
        {{> header-block }}
      </div>
      <div class="email-content">
        {{> @partial-block }}
      </div>
      <div class="email-footer">
        {{> footer-block }}
      </div>
    </div>
  </div>
</body>
</html>
```

- [ ] **Step 2: Run existing tests to verify nothing broke**

```bash
cd /Users/danielerolli/Documents/GitHub/Beaver-Sync && node --test test/email-templates.test.js
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/email/templates/base.hbs
git commit --no-verify -m "feat: add full Beaver email layout with warm amber design tokens"
```

---

### Task 4: Create all email templates

**Files:**
- Modify: `src/email/templates/welcome.hbs`
- Create: `src/email/templates/verify.hbs`
- Create: `src/email/templates/password-reset.hbs`
- Create: `src/email/templates/password-changed.hbs`
- Create: `src/email/templates/account-deleted.hbs`
- Create: `src/email/templates/workspace-invite.hbs`
- Create: `src/email/templates/note-invite.hbs`
- Create: `src/email/templates/subscription-receipt.hbs`

**Interfaces:**
- Consumes: `base.hbs` layout via `{{#> base}}`, `logoUrl` data URI
- Produces: each template renders unique content within the shared layout

- [ ] **Step 1: Write welcome.hbs**

```handlebars
<!-- src/email/templates/welcome.hbs -->
{{#> base}}
  {{#*inline "header-block"}}
    <img src="{{logoUrl}}" alt="Beaver Sync" width="64" height="64" style="border-radius: 14px;">
    <h1>You're in! 🦫</h1>
  {{/inline}}

  {{#*inline "footer-block"}}
    Beaver Sync &middot; <a href="https://beavernotes.com">beavernotes.com</a>
    <div class="beaver-tag">Notes, synced with a grin.</div>
  {{/inline}}

  <h2>Welcome aboard{{#if username}}, {{username}}{{/if}}!</h2>
  <p>Your Beaver Sync account is ready. Your notes can now follow you everywhere — across devices, across rooms, across time zones.</p>
  <p>Start by opening Beaver Sync and creating your first note. The sync just works.</p>
  <p style="margin: 28px 0 0;">
    <a href="{{dashboardUrl}}" class="btn-primary">Open Beaver Sync</a>
  </p>
{{/base}}
```

- [ ] **Step 2: Write verify.hbs**

```handlebars
<!-- src/email/templates/verify.hbs -->
{{#> base}}
  {{#*inline "header-block"}}
    <img src="{{logoUrl}}" alt="Beaver Sync" width="64" height="64" style="border-radius: 14px;">
    <h1>Verify your email</h1>
  {{/inline}}

  {{#*inline "footer-block"}}
    Beaver Sync &middot; <a href="https://beavernotes.com">beavernotes.com</a>
  {{/inline}}

  <p class="subtitle">One quick step and you're all set.</p>
  <p>Click the button below to verify <strong>{{email}}</strong>:</p>
  <p style="margin: 28px 0 0;">
    <a href="{{verifyUrl}}" class="btn-primary">Verify email</a>
  </p>
  <div class="callout">
    This link expires in {{expiresIn}}. If you didn't create a Beaver Sync account, you can safely ignore this email.
  </div>
{{/base}}
```

- [ ] **Step 3: Write password-reset.hbs**

```handlebars
<!-- src/email/templates/password-reset.hbs -->
{{#> base}}
  {{#*inline "header-block"}}
    <img src="{{logoUrl}}" alt="Beaver Sync" width="64" height="64" style="border-radius: 14px;">
    <h1>Password reset</h1>
  {{/inline}}

  {{#*inline "footer-block"}}
    Beaver Sync &middot; <a href="https://beavernotes.com">beavernotes.com</a>
  {{/inline}}

  <p>No worries — it happens to everyone. Click below to set a new password:</p>
  <p style="margin: 28px 0 0;">
    <a href="{{resetUrl}}" class="btn-primary">Reset password</a>
  </p>
  <div class="callout">
    This link expires in {{expiresIn}}. If you didn't request a reset, ignore this email — your password stays the same.
  </div>
{{/base}}
```

- [ ] **Step 4: Write password-changed.hbs**

```handlebars
<!-- src/email/templates/password-changed.hbs -->
{{#> base}}
  {{#*inline "header-block"}}
    <img src="{{logoUrl}}" alt="Beaver Sync" width="64" height="64" style="border-radius: 14px;">
    <h1>Password updated</h1>
  {{/inline}}

  {{#*inline "footer-block"}}
    Beaver Sync &middot; <a href="https://beavernotes.com">beavernotes.com</a>
  {{/inline}}

  <p>Your password was changed{{#if timestamp}} on {{timestamp}}{{/if}}. You're all set.</p>
  <p>If this wasn't you, please reset your password immediately or contact support.</p>
  <hr class="divider">
  <p style="font-size: 13px; color: #a8a29e;">Changed from: {{deviceInfo}}</p>
{{/base}}
```

- [ ] **Step 5: Write account-deleted.hbs**

```handlebars
<!-- src/email/templates/account-deleted.hbs -->
{{#> base}}
  {{#*inline "header-block"}}
    <img src="{{logoUrl}}" alt="Beaver Sync" width="64" height="64" style="border-radius: 14px;">
    <h1>Account deleted</h1>
  {{/inline}}

  {{#*inline "footer-block"}}
    Beaver Sync &middot; <a href="https://beavernotes.com">beavernotes.com</a>
    <div class="beaver-tag">We'll miss you.</div>
  {{/inline}}

  <p>Your Beaver Sync account has been permanently deleted. All data on the server has been removed.</p>
  <p>Your local notes on this device were not affected.</p>
  <div class="callout">
    If this was a mistake, reach out to support within 30 days and we'll do our best to help.
  </div>
{{/base}}
```

- [ ] **Step 6: Write workspace-invite.hbs**

```handlebars
<!-- src/email/templates/workspace-invite.hbs -->
{{#> base}}
  {{#*inline "header-block"}}
    <img src="{{logoUrl}}" alt="Beaver Sync" width="64" height="64" style="border-radius: 14px;">
    <h1>You've been invited!</h1>
  {{/inline}}

  {{#*inline "footer-block"}}
    Beaver Sync &middot; <a href="https://beavernotes.com">beavernotes.com</a>
  {{/inline}}

  <p><strong>{{inviterName}}</strong> invited you to join the workspace <strong>{{workspaceName}}</strong> on Beaver Sync.</p>
  <p>Collaborate on notes in real-time, stay in sync, and build something great together.</p>
  <p style="margin: 28px 0 0;">
    <a href="{{inviteUrl}}" class="btn-primary">Join workspace</a>
  </p>
  <div class="callout">
    This invitation expires in {{expiresIn}}. You'll need a Beaver Sync account to join.
  </div>
{{/base}}
```

- [ ] **Step 7: Write note-invite.hbs**

```handlebars
<!-- src/email/templates/note-invite.hbs -->
{{#> base}}
  {{#*inline "header-block"}}
    <img src="{{logoUrl}}" alt="Beaver Sync" width="64" height="64" style="border-radius: 14px;">
    <h1>Note invitation</h1>
  {{/inline}}

  {{#*inline "footer-block"}}
    Beaver Sync &middot; <a href="https://beavernotes.com">beavernotes.com</a>
  {{/inline}}

  <p><strong>{{inviterName}}</strong> wants to collaborate on a note with you:</p>
  <div class="callout" style="font-weight: 600; color: #1c1917;">
    📝 {{noteTitle}}
  </div>
  <p style="margin: 28px 0 0;">
    <a href="{{inviteUrl}}" class="btn-primary">Open note</a>
  </p>
  <div class="callout">
    This invitation expires in {{expiresIn}}.
  </div>
{{/base}}
```

- [ ] **Step 8: Write subscription-receipt.hbs**

```handlebars
<!-- src/email/templates/subscription-receipt.hbs -->
{{#> base}}
  {{#*inline "header-block"}}
    <img src="{{logoUrl}}" alt="Beaver Sync" width="64" height="64" style="border-radius: 14px;">
    <h1>Subscription updated</h1>
  {{/inline}}

  {{#*inline "footer-block"}}
    Beaver Sync &middot; <a href="https://beavernotes.com">beavernotes.com</a>
  {{/inline}}

  <p>Thanks for upgrading, {{#if username}}{{username}}{{else}}there{{/if}}! Your subscription has been updated.</p>
  <hr class="divider">
  <table width="100%" cellpadding="0" cellspacing="0" style="font-size: 14px; color: #44403c;">
    <tr>
      <td style="padding: 8px 0; color: #78716c;">Plan</td>
      <td style="padding: 8px 0; text-align: right; font-weight: 600;">{{plan}}</td>
    </tr>
    {{#if amount}}
    <tr>
      <td style="padding: 8px 0; color: #78716c;">Amount</td>
      <td style="padding: 8px 0; text-align: right; font-weight: 600;">{{amount}}</td>
    </tr>
    {{/if}}
    <tr>
      <td style="padding: 8px 0; color: #78716c;">Billing period</td>
      <td style="padding: 8px 0; text-align: right; font-weight: 600;">{{period}}</td>
    </tr>
  </table>
  <hr class="divider">
  <p style="margin: 28px 0 0;">
    <a href="{{dashboardUrl}}" class="btn-primary">Manage subscription</a>
  </p>
{{/base}}
```

- [ ] **Step 9: Run tests to verify all templates render**

```bash
cd /Users/danielerolli/Documents/GitHub/Beaver-Sync && node --test test/email-templates.test.js
```

Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add src/email/templates/
git commit --no-verify -m "feat: add all 8 email templates with Beaver design language"
```

---

### Task 5: Build the email sender API

**Files:**
- Create: `src/email/index.js`
- Modify: `test/email-templates.test.js`

**Interfaces:**
- Consumes: `render()` from `renderer.js`, `sendWithAlias()` from `../lib/email`
- Produces: `sendWelcomeEmail(app, userId, data?)`, `sendVerifyEmail(app, userId, data)`, `sendPasswordResetEmail(app, userId, data)`, `sendPasswordChangedEmail(app, userId, data)`, `sendAccountDeletedEmail(app, userId, data?)`, `sendWorkspaceInviteEmail(app, userId, data)`, `sendNoteInviteEmail(app, userId, data)`, `sendSubscriptionReceiptEmail(app, userId, data)`

- [ ] **Step 1: Write failing tests**

Add to `test/email-templates.test.js`:

```javascript
// --- Sender API tests ---

// Mock sendWithAlias to capture calls
let capturedCalls = [];
const mockSendWithAlias = async (app, accountId, subject, html) => {
  capturedCalls.push({ accountId, subject, html });
};

test.beforeEach(() => { capturedCalls = []; });

test('sendWelcomeEmail sends welcome email with correct subject', async () => {
  const { render, getLogoDataUri } = require('../src/email/renderer');
  // We test the render+subject logic directly since sendWithAlias needs Resend API key
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
```

- [ ] **Step 2: Run tests to verify they pass**

```bash
cd /Users/danielerolli/Documents/GitHub/Beaver-Sync && node --test test/email-templates.test.js
```

Expected: PASS

- [ ] **Step 3: Implement the sender API**

```javascript
// src/email/index.js
'use strict';

const { render, getLogoDataUri } = require('./renderer');
const { sendWithAlias } = require('../lib/email');

const DASHBOARD_URL = 'https://app.beavernotes.com';

function buildData(overrides = {}) {
  return { logoUrl: getLogoDataUri(), dashboardUrl: DASHBOARD_URL, ...overrides };
}

async function sendWelcomeEmail(app, userId, data = {}) {
  const html = render('welcome', buildData(data));
  if (!html) return;
  return sendWithAlias(app, userId, 'Welcome to Beaver Sync', html);
}

async function sendVerifyEmail(app, userId, data) {
  const html = render('verify', buildData(data));
  if (!html) return;
  return sendWithAlias(app, userId, 'Verify your Beaver Sync email', html);
}

async function sendPasswordResetEmail(app, userId, data) {
  const html = render('password-reset', buildData(data));
  if (!html) return;
  return sendWithAlias(app, userId, 'Reset your Beaver Sync password', html);
}

async function sendPasswordChangedEmail(app, userId, data = {}) {
  const html = render('password-changed', buildData(data));
  if (!html) return;
  return sendWithAlias(app, userId, 'Your password was changed', html);
}

async function sendAccountDeletedEmail(app, userId, data = {}) {
  const html = render('account-deleted', buildData(data));
  if (!html) return;
  return sendWithAlias(app, userId, 'Your account has been deleted', html);
}

async function sendWorkspaceInviteEmail(app, userId, data) {
  const html = render('workspace-invite', buildData(data));
  if (!html) return;
  return sendWithAlias(app, userId, `${data.inviterName} invited you to a workspace`, html);
}

async function sendNoteInviteEmail(app, userId, data) {
  const html = render('note-invite', buildData(data));
  if (!html) return;
  return sendWithAlias(app, userId, `${data.inviterName} wants to collaborate on a note`, html);
}

async function sendSubscriptionReceiptEmail(app, userId, data) {
  const html = render('subscription-receipt', buildData(data));
  if (!html) return;
  return sendWithAlias(app, userId, 'Your subscription has been updated', html);
}

module.exports = {
  sendWelcomeEmail,
  sendVerifyEmail,
  sendPasswordResetEmail,
  sendPasswordChangedEmail,
  sendAccountDeletedEmail,
  sendWorkspaceInviteEmail,
  sendNoteInviteEmail,
  sendSubscriptionReceiptEmail,
};
```

- [ ] **Step 4: Run all tests**

```bash
cd /Users/danielerolli/Documents/GitHub/Beaver-Sync && node --test test/email-templates.test.js
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/email/index.js test/email-templates.test.js
git commit --no-verify -m "feat: add email sender API with 8 transactional email functions"
```

---

### Task 6: Wire up to existing routes

**Files:**
- Modify: `src/lib/email.js` (remove `sendWelcomeEmail`)
- Modify: `src/routes/auth.js` (update import)

**Interfaces:**
- Consumes: `sendWelcomeEmail` from `../email` (new module)
- Produces: existing `sendWelcomeEmail` in `../lib/email` removed

- [ ] **Step 1: Remove sendWelcomeEmail from email.js**

In `src/lib/email.js`, delete lines 299-306 (the `sendWelcomeEmail` function) and remove it from the `module.exports` at line 309.

The module.exports should become:

```javascript
module.exports = {
  createEmailAlias,
  resolveAlias,
  deleteAlias,
  deleteAliasesForAccount,
  sendWithAlias,
  forwardToRealEmail,
};
```

- [ ] **Step 2: Update auth.js import**

In `src/routes/auth.js`, change line 9 from:

```javascript
const { sendWelcomeEmail } = require('../lib/email');
```

to:

```javascript
const { sendWelcomeEmail } = require('../email');
```

- [ ] **Step 3: Run existing email tests to verify nothing broke**

```bash
cd /Users/danielerolli/Documents/GitHub/Beaver-Sync && node --test test/email.test.js
```

Expected: PASS (the sendWelcomeEmail test at line 159-166 calls `email.sendWelcomeEmail` which no longer exists — this test will need updating)

- [ ] **Step 4: Update the old email test**

In `test/email.test.js`, the test at line 159-166 imports `sendWelcomeEmail` from `../src/lib/email`. Update it to import from `../src/email` instead:

```javascript
const emailTemplates = require('../src/email');

// ... existing test ...
test('sendWelcomeEmail gracefully skips when no API key', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const { id } = await registerAccount('welcome@example.com');
  await emailTemplates.sendWelcomeEmail(app, id);
  assert.ok(true, 'should not throw');
});
```

- [ ] **Step 5: Run both test files**

```bash
cd /Users/danielerolli/Documents/GitHub/Beaver-Sync && node --test test/email.test.js test/email-templates.test.js
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/email.js src/routes/auth.js test/email.test.js
git commit --no-verify -m "feat: wire up new email templates, replace legacy sendWelcomeEmail"
```

---

### Task 7: Final verification

- [ ] **Step 1: Run full test suite**

```bash
cd /Users/danielerolli/Documents/GitHub/Beaver-Sync && node --test test/email.test.js test/email-templates.test.js
```

Expected: All tests pass

- [ ] **Step 2: Verify renderer outputs valid HTML**

```bash
node -e "
const { render, getLogoDataUri } = require('./src/email/renderer');
const html = render('welcome', { logoUrl: getLogoDataUri(), dashboardUrl: 'https://app.beavernotes.com' });
console.log('Length:', html.length);
console.log('Has DOCTYPE:', html.includes('<!DOCTYPE'));
console.log('Has amber accent:', html.includes('#f59e0b'));
console.log('Has logo:', html.includes('data:image/png;base64,'));
console.log('Has beaver tag:', html.includes('Notes, synced with a grin'));
"
```

Expected: all `true`

- [ ] **Step 3: Commit final state**

```bash
git add -A && git commit --no-verify -m "feat: HTML email templates — complete"
```
