# HTML Email Templates Design

## Overview

Add Handlebars-based HTML email templates to Beaver-Sync for all transactional emails. Currently only one email exists (welcome) as raw inline HTML with no layout. This replaces it with a proper template system and adds missing transactional emails.

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
    base.hbs              ← shared layout (wrapper, header slot, footer)
    welcome.hbs           ← {{> content}} partial
    verify.hbs
    password-reset.hbs
    password-changed.hbs
    account-deleted.hbs
    workspace-invite.hbs
    note-invite.hbs
    subscription-receipt.hbs
  renderer.js             ← render(templateName, data) → compiled HTML
  index.js                ← sendXxxEmail() public API
```

### renderer.js

- On first call to `render(name, data)`, reads `templates/{name}.hbs` from disk, compiles with Handlebars, caches in a `Map`
- Also compiles `base.hbs` as a layout — each content template registers itself as a partial, then `base.hbs` wraps it via `{{> @partial-block }}`
- Returns a full HTML string ready to pass to Resend
- Handles missing templates gracefully (logs error, returns null)

### index.js

- Imports `render` from `renderer.js`
- Imports `sendWithAlias` from `../lib/email.js`
- Exports one function per email type: `sendWelcomeEmail(app, userId, data)`, `sendVerifyEmail(...)`, etc.
- Each function: `const html = render('template-name', data); if (!html) return; await sendWithAlias(app, userId, subject, html);`
- Subject lines are defined here, not in templates

### base.hbs layout

```handlebars
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    /* Reset + email-safe base styles */
    body { margin: 0; padding: 0; background: #f4f4f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    .container { max-width: 560px; margin: 0 auto; background: #ffffff; }
    .header { padding: 32px 24px; text-align: center; }
    .content { padding: 0 24px 32px; color: #18181b; font-size: 15px; line-height: 1.6; }
    .footer { padding: 24px; text-align: center; font-size: 12px; color: #a1a1aa; border-top: 1px solid #e4e4e7; }
    .btn { display: inline-block; padding: 10px 24px; background: #2563eb; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 500; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <!-- Beaver Sync logo or wordmark -->
    </div>
    <div class="content">
      {{> @partial-block }}
    </div>
    <div class="footer">
      Beaver Sync · <a href="https://beavernotes.com">beavernotes.com</a>
    </div>
  </div>
</body>
</html>
```

### Template example (welcome.hbs)

```handlebars
{{#> base}}
  <h2>Welcome to Beaver Sync{{#if username}}, {{username}}{{/if}}</h2>
  <p>Your account is ready. You can now sync your notes across all your devices.</p>
  <p style="margin-top: 24px;">
    <a href="{{dashboardUrl}}" class="btn">Open Beaver Sync</a>
  </p>
{{/base}}
```

### Template variables

Each template receives a `data` object. Required variables per template:

| Template | Variables |
|----------|-----------|
| `welcome` | `username?`, `dashboardUrl` |
| `verify` | `username?`, `verifyUrl`, `expiresIn` |
| `password-reset` | `username?`, `resetUrl`, `expiresIn` |
| `password-changed` | `username?`, `timestamp` |
| `account-deleted` | `username?`, `timestamp` |
| `workspace-invite` | `inviterName`, `workspaceName`, `inviteUrl`, `expiresIn` |
| `note-invite` | `inviterName`, `noteTitle`, `inviteUrl`, `expiresIn` |
| `subscription-receipt` | `username?`, `plan`, `amount?`, `period`, `dashboardUrl` |

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

- `handlebars` npm package (runtime only, no compiler in production — but we need the compiler for `.hbs` files, so use the full package)

### File structure

```
src/email/
  renderer.js          ~40 lines
  index.js             ~120 lines (8 email functions)
  templates/
    base.hbs           ~30 lines
    welcome.hbs        ~8 lines
    verify.hbs         ~10 lines
    password-reset.hbs ~10 lines
    password-changed.hbs ~8 lines
    account-deleted.hbs ~8 lines
    workspace-invite.hbs ~12 lines
    note-invite.hbs    ~12 lines
    subscription-receipt.hbs ~15 lines
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
