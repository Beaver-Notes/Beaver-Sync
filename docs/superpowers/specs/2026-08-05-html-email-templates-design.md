# HTML Email Templates Design

## Overview

Add Handlebars-based HTML email templates to Beaver-Sync for all transactional emails. Currently only one email exists (welcome) as raw inline HTML with no layout. This replaces it with a proper template system that reflects Beaver's warm, playful-but-professional design language.

## Design Language

Beaver's visual identity carries into emails:

- **Warm amber accent** (`#f59e0b`) — the signature color, used for buttons, links, and decorative elements
- **Cream/beige header gradient** (`#fffbeb → #fef3c7`) — warm glow inspired by the beaver logo's tones
- **Warm grays** — not cold blue-grays; the neutral palette stays earthy (`#faf9f7` warm white, `#1c1917` warm near-black)
- **Rounded corners** — 12px for the card container, 8px for buttons, matching the app's `rounded-xl` / `rounded-lg` tokens
- **System font stack** — `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`
- **Playful tone** — friendly copy, not corporate. The beaver mascot makes people smile; the emails should too
- **The beaver logo** — inline as a base64-encoded data URI in the header, so it renders without external image loading
- **Warm amber callouts** — info boxes use `#fffbeb` background with a `#f59e0b` left border stripe

## Email Types

| Email | Trigger | Template |
|-------|---------|----------|
| Welcome | `POST /auth/register` | `welcome.hbs` |
| Email verification | `POST /auth/verify-email` (new) | `verify.hbs` |
| Password reset | `POST /auth/password-reset` (new) | `password-reset.hbs` |
| Password changed | After successful password change | `password-changed.hbs` |
| Account deleted | After `DELETE /account` | `account-deleted.hbs` |
| Workspace invite | `POST /workspaces/:id/invite` (new) | `workspace-invite.hbs` |
| Note invite | `POST /collaboration/invite/:noteId` (new) | `note-invite.hbs` |
| Subscription receipt | After plan change/upgrade | `subscription-receipt.hbs` |

## Architecture

```
src/email/
  templates/
    base.hbs              ← shared layout (wrapper, header with logo, footer)
    welcome.hbs           ← content block within base
    verify.hbs
    password-reset.hbs
    password-changed.hbs
    account-deleted.hbs
    workspace-invite.hbs
    note-invite.hbs
    subscription-receipt.hbs
  renderer.js             ← render(templateName, data) → compiled HTML
  index.js                ← sendXxxEmail() public API
  assets/
    logo.png              ← beaver logo (copied from frontend assets)
```

### renderer.js

- On first call to `render(name, data)`, reads `templates/{name}.hbs` from disk, compiles with Handlebars, caches in a `Map`
- Also compiles `base.hbs` as a layout — each content template defines `header-block` and `footer-block` inline partials, and the main content goes into `@partial-block`
- Injects `logoUrl` automatically — reads `assets/logo.png`, base64-encodes it, passes as `data: image/png;base64,...` URI
- Returns a full HTML string ready to pass to Resend
- Handles missing templates gracefully (logs error, returns null)

### index.js

- Imports `render` from `renderer.js`
- Imports `sendWithAlias` from `../lib/email.js`
- Exports one function per email type: `sendWelcomeEmail(app, userId, data)`, `sendVerifyEmail(...)`, etc.
- Each function: `const html = render('template-name', data); if (!html) return; await sendWithAlias(app, userId, subject, html);`
- Subject lines are defined here, not in templates

### base.hbs — The Beaver email layout

The base layout uses Beaver's warm palette. All styles are in a `<style>` block (email client compatibility). The logo is embedded as a base64 data URI to avoid broken images from external URL blocking.

```handlebars
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
    .btn-secondary {
      display: inline-block; padding: 11px 28px;
      background-color: #faf9f7; color: #78716c !important;
      text-decoration: none; border-radius: 8px;
      font-weight: 600; font-size: 14px;
      border: 1px solid #e7e5e4;
    }
    .code-block {
      background: #faf9f7; border: 1px solid #e7e5e4;
      border-radius: 8px; padding: 16px 20px;
      font-family: 'JetBrains Mono', 'SF Mono', 'Fira Code', monospace;
      font-size: 18px; letter-spacing: 4px;
      color: #1c1917; text-align: center;
      margin: 20px 0;
    }
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

**Design tokens derived from the app:**

| Token | Email value | Source |
|-------|-------------|--------|
| Accent | `#f59e0b` (amber-500) | `--twc-primary` light theme |
| Accent hover | `#d97706` (amber-600) | Darker on interaction |
| Warm background | `#faf9f7` (stone-50) | App's `neutral-50` shifted warm |
| Card background | `#ffffff` | Same as app cards |
| Header gradient | `#fffbeb → #fef3c7` (amber-50 → amber-100) | Warm beaver glow |
| Header border | `#fde68a` (amber-200) | Subtle gold line |
| Body text | `#44403c` (stone-700) | Warm gray, not cold |
| Heading text | `#1c1917` (stone-900) | Near-black, warm |
| Muted text | `#78716c` (stone-500) | For subtitles |
| Light muted | `#a8a29e` (stone-400) | Footer text |
| Border | `#e7e5e4` (stone-200) | Dividers, code blocks |
| Code bg | `#faf9f7` (stone-50) | Light warm tint |
| Callout bg | `#fffbeb` (amber-50) | Warm highlight |
| Callout border | `#f59e0b` (amber-500) | Accent stripe |
| Callout text | `#92400e` (amber-800) | Dark amber |

### Template designs

Each template defines its own `header-block` and `footer-block` inline partials, then puts its unique content in `@partial-block`. This gives every email its own personality while sharing the same layout skeleton.

**welcome.hbs** — Warm, excited, the beaver is happy you're here:

```handlebars
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

**verify.hbs** — Clean, quick, get out of the way:

```handlebars
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

**password-reset.hbs** — Calm, reassuring, the beaver's got this:

```handlebars
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

**password-changed.hbs** — Confirmation with a thumbs up:

```handlebars
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

**account-deleted.hbs** — Respectful, clear, no dark patterns:

```handlebars
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

**workspace-invite.hbs** — Social, inviting:

```handlebars
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

**note-invite.hbs** — Specific, focused:

```handlebars
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

**subscription-receipt.hbs** — Professional, clear:

```handlebars
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

### Template variables

Each template receives a `data` object. Required variables per template:

| Template | Variables |
|----------|-----------|
| `welcome` | `username?`, `dashboardUrl`, `logoUrl` |
| `verify` | `username?`, `email`, `verifyUrl`, `expiresIn`, `logoUrl` |
| `password-reset` | `username?`, `resetUrl`, `expiresIn`, `logoUrl` |
| `password-changed` | `username?`, `timestamp`, `deviceInfo`, `logoUrl` |
| `account-deleted` | `username?`, `timestamp`, `logoUrl` |
| `workspace-invite` | `inviterName`, `workspaceName`, `inviteUrl`, `expiresIn`, `logoUrl` |
| `note-invite` | `inviterName`, `noteTitle`, `inviteUrl`, `expiresIn`, `logoUrl` |
| `subscription-receipt` | `username?`, `plan`, `amount?`, `period`, `dashboardUrl`, `logoUrl` |

**`logoUrl`** — The renderer injects this automatically. It's a `data:` URI containing the beaver logo as base64-encoded PNG (inline, no external dependency). This avoids broken images from email client URL blocking. The logo is 64x64, ~2KB base64.

### Integration with existing code

**`src/lib/email.js` changes:**
- `sendWithAlias` stays unchanged — it's the low-level transport
- `sendWelcomeEmail` moves to `src/email/index.js` and is removed from `email.js`
- `email.js` exports: `sendWithAlias`, alias management functions, `forwardToRealEmail`

**`src/routes/auth.js` changes:**
- Replace `require('../lib/email').sendWelcomeEmail` with `require('../email').sendWelcomeEmail`

**New email-sending routes (future work, not in this spec):**
- Password reset flow in `auth.js`
- Email verification in `auth.js`
- Workspace invite via email in `workspaces.js`
- Note invite via email in collaboration routes

### Error handling

- If a template file is missing or malformed, `render()` logs a warning and returns `null`
- If `render()` returns null, the `sendXxxEmail()` function skips sending and logs — it never throws
- If `sendWithAlias` fails (Resend API error, alias not found), the error propagates to the caller
- No retry logic — Resend handles retries internally

### Dependencies

- `handlebars` npm package (full package — we need the compiler for `.hbs` files)

### File structure

```
src/email/
  renderer.js          ~50 lines
  index.js             ~120 lines (8 email functions)
  templates/
    base.hbs           ~70 lines (full email layout with CSS)
    welcome.hbs        ~12 lines
    verify.hbs         ~14 lines
    password-reset.hbs ~14 lines
    password-changed.hbs ~12 lines
    account-deleted.hbs ~12 lines
    workspace-invite.hbs ~14 lines
    note-invite.hbs    ~14 lines
    subscription-receipt.hbs ~22 lines
  assets/
    logo.png           ← beaver logo (copied from frontend assets)
```

### Testing

- Unit test for `renderer.js`: compiles each template with sample data, asserts no errors, asserts output contains expected strings
- Unit test for `index.js`: mock `sendWithAlias`, call each `sendXxxEmail`, assert correct subject and HTML output
- Update existing `email.test.js` to not break (sendWelcomeEmail moves but API stays the same)

### Environment variables

Uses existing `RESEND_API_KEY` and `RESEND_FROM_ADDRESS`. No new env vars required.

The `dashboardUrl` variable passed to templates defaults to `https://app.beavernotes.com` but can be overridden per-template call via the data object. No env var needed — callers pass it directly.

### Migration

- The existing welcome email in `src/lib/email.js` (lines 299-306) gets replaced by the new template-based version
- No database migration needed
- No environment variable changes — uses existing `RESEND_API_KEY` and `RESEND_FROM_ADDRESS`
