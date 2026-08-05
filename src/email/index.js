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
