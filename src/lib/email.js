"use strict";

const { Resend } = require("resend");
const mlkem = require("./mlkem");

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_ADDRESS =
  process.env.RESEND_FROM_ADDRESS ?? "noreply@beavernotes.com";

let resend = null;

function getResend() {
  if (!RESEND_API_KEY) return null;
  if (!resend) resend = new Resend(RESEND_API_KEY);
  return resend;
}

async function sendWelcomeEmail(app, userId) {
  const client = getResend();
  if (!client) {
    app.log.debug("RESEND_API_KEY not set - skipping welcome email");
    return;
  }

  try {
    const { Account } = require("../models");
    const account = await Account.findById(userId, {
      emailEncrypted: 1,
    }).lean();
    if (!account?.emailEncrypted) {
      app.log.warn(
        { userId },
        "Cannot send welcome email - no emailEncrypted on account",
      );
      return;
    }

    const email = await mlkem.decryptMetadata(account.emailEncrypted);
    app.log.info({ userId }, "Sending welcome email");

    await client.emails.send({
      from: FROM_ADDRESS,
      to: email,
      subject: "Welcome to Beaver Sync",
      html: `<p>Your account is ready.</p><p>You can now sync your notes across all your devices.</p>`,
    });
  } catch (err) {
    app.log.error({ err, userId }, "Failed to send welcome email");
  }
}

module.exports = { sendWelcomeEmail };
