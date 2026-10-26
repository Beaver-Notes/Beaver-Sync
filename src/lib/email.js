"use strict";

const crypto = require("crypto");
const net = require("net");
const tls = require("tls");
const { Resend } = require("resend");
const mlkem = require("./mlkem");

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_ADDRESS =
  process.env.RESEND_FROM_ADDRESS ?? "noreply@beavernotes.com";
const NOTIFY_DOMAIN = process.env.NOTIFY_DOMAIN ?? "notify.beavernotes.com";

let resend = null;

function getResend() {
  if (!RESEND_API_KEY) return null;
  if (!resend) resend = new Resend(RESEND_API_KEY);
  return resend;
}

function generateAliasToken() {
  return crypto.randomBytes(16).toString("base64url").toLowerCase();
}

// Prevent CR/LF injection into SMTP commands and message headers.
function sanitizeHeader(value) {
  return String(value ?? "").replace(/[\r\n]/g, "").trim();
}

async function createEmailAlias(accountId, emailSealed, ttlMs) {
  const token = generateAliasToken();
  const alias = `${token}@${NOTIFY_DOMAIN}`;

  const data = {
    alias,
    accountId,
    emailSealed,
    createdAt: new Date(),
  };

  if (ttlMs) {
    data.expiresAt = new Date(Date.now() + ttlMs);
  }

  const { EmailAlias } = require("../models");
  await EmailAlias.create(data);
  return alias;
}

async function resolveAlias(alias) {
  const { EmailAlias } = require("../models");
  const record = await EmailAlias.findOne({ alias }).lean();
  if (!record) return null;

  if (record.expiresAt && new Date(record.expiresAt) < new Date()) {
    await EmailAlias.deleteOne({ alias });
    return null;
  }

  const email = await mlkem.decryptMetadata(record.emailSealed);
  return { accountId: record.accountId, email };
}

async function deleteAlias(alias) {
  const { EmailAlias } = require("../models");
  return EmailAlias.deleteOne({ alias });
}

async function deleteAliasesForAccount(accountId) {
  const { EmailAlias } = require("../models");
  return EmailAlias.deleteMany({ accountId });
}

async function sendWithAlias(app, accountId, subject, html) {
  const client = getResend();
  if (!client) {
    app.log.debug("RESEND_API_KEY not set - skipping email");
    return;
  }

  if (process.env.EMAIL_ENABLED === "false") {
    app.log.debug("EMAIL_ENABLED=false - skipping email send");
    return;
  }

  try {
    const { Account } = require("../models");
    const account = await Account.findById(accountId, {
      emailSealed: 1,
    }).lean();
    if (!account?.emailSealed) {
      app.log.warn({ accountId }, "Cannot send email - no emailSealed");
      return;
    }

    const { EmailAlias } = require("../models");
    const aliasRecord = await EmailAlias.findOne({ accountId }).lean();
    let alias;

    if (
      aliasRecord &&
      (!aliasRecord.expiresAt || new Date(aliasRecord.expiresAt) > new Date())
    ) {
      alias = aliasRecord.alias;
    } else {
      if (aliasRecord) await EmailAlias.deleteOne({ alias: aliasRecord.alias });
      alias = await createEmailAlias(accountId, account.emailSealed);
    }

    app.log.info({ accountId, alias }, "Sending email via alias");

    await client.emails.send({
      from: FROM_ADDRESS,
      to: alias,
      subject,
      html,
    });
  } catch (err) {
    app.log.error({ err, accountId }, "Failed to send email");
  }
}

async function forwardToRealEmail(alias, emailContent) {
  const resolved = await resolveAlias(alias);
  if (!resolved) {
    throw new Error(`Alias not found or expired: ${alias}`);
  }

  const forwardHost = process.env.FORWARD_SMTP_HOST;
  if (forwardHost) {
    const forwardPort = parseInt(process.env.FORWARD_SMTP_PORT || "587", 10);
    const forwardUser = process.env.FORWARD_SMTP_USER || "";
    const forwardPass = process.env.FORWARD_SMTP_PASS || "";
    const forwardFrom =
      process.env.FORWARD_FROM_ADDRESS || FROM_ADDRESS;

    await sendViaSmtp({
      host: forwardHost,
      port: forwardPort,
      user: forwardUser,
      pass: forwardPass,
      from: forwardFrom,
      to: resolved.email,
      subject: emailContent.subject || "Forwarded message",
      html: emailContent.html || emailContent.text || "",
    });
  } else if (process.env.FORWARD_TYPE === "sendmail") {
    await sendViaSendmail(resolved.email, emailContent);
  }

  return resolved;
}

async function sendViaSmtp({ host, port, user, pass, from, to, subject, html }) {
  return new Promise((resolve, reject) => {
    const useTls = port === 465;
    let socket = useTls
      ? tls.connect(port, host, { servername: host })
      : net.connect(port, host);

    let buffer = "";
    let step = 0;
    let authenticated = false;

    function send(line) {
      socket.write(line + "\r\n");
    }

    from = sanitizeHeader(from);
    to = sanitizeHeader(to);
    subject = sanitizeHeader(subject);

    function onData(data) {
      buffer += data.toString();
      const lines = buffer.split("\r\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.length < 3) continue;
        const code = parseInt(line.substring(0, 3), 10);
        const isContinuation = line.length > 3 && line[3] === "-";

        if (isContinuation) continue;

        if (code >= 400) {
          socket.destroy();
          reject(new Error(`SMTP error: ${line}`));
          return;
        }

        if (!authenticated) {
          switch (step) {
            case 0:
              send(`EHLO beaver-sync`);
              step++;
              break;
            case 1:
              if (useTls) {
                send(`AUTH LOGIN`);
              } else if (port === 587) {
                send("STARTTLS");
              } else {
                if (user) send("AUTH LOGIN");
                else authenticated = true;
              }
              step++;
              break;
            case 2:
              if (!useTls && port === 587) {
                const tlsSocket = tls.connect({ socket, servername: host });
                socket.removeAllListeners();
                socket = tlsSocket;
                tlsSocket.on("data", onData);
                tlsSocket.write("EHLO beaver-sync\r\n");
                step = 3;
                return;
              }
              if (user) {
                send(Buffer.from(user).toString("base64"));
                step++;
              } else {
                authenticated = true;
                send(`MAIL FROM:<${from}>`);
                step = 5;
              }
              break;
            case 3:
              send(Buffer.from(pass).toString("base64"));
              step++;
              break;
            case 4:
              authenticated = true;
              send(`MAIL FROM:<${from}>`);
              step++;
              break;
            case 5:
              send(`RCPT TO:<${to}>`);
              step++;
              break;
            case 6:
              send("DATA");
              step++;
              break;
            case 7:
              {
                // SMTP dot-stuffing (RFC 5321 §4.5.2): any line beginning with
                // '.' must be escaped as '..' so a single '.' terminates DATA.
                const stuffed = String(html).split(/\r?\n/).map((l) => (l.startsWith('.') ? '.' + l : l)).join('\r\n');
                const msg = [
                  `From: ${from}`,
                  `To: ${to}`,
                  `Subject: ${subject}`,
                  "MIME-Version: 1.0",
                  "Content-Type: text/html; charset=utf-8",
                  "",
                  stuffed,
                  ".",
                ].join("\r\n");
                send(msg);
                step++;
              }
              break;
            case 8:
              socket.write("QUIT\r\n");
              socket.end();
              resolve();
              break;
          }
        } else {
          authenticated = true;
          send(`MAIL FROM:<${from}>`);
          step = 5;
        }
      }
    }

    socket.on("data", onData);
    socket.on("error", reject);
    socket.on("close", () => {
      if (step < 8) reject(new Error("SMTP connection closed prematurely"));
    });

    setTimeout(() => reject(new Error("SMTP timeout")), 10000);
  });
}

async function sendViaSendmail(to, { subject, html, text }) {
  const { spawn } = require("child_process");
  return new Promise((resolve, reject) => {
    const sendmail = spawn("/usr/sbin/sendmail", ["-i", "-t"]);
    let stderr = "";

    sendmail.on("error", (err) => reject(err));
    sendmail.stderr.on("data", (d) => { stderr += d.toString(); });

    to = sanitizeHeader(to);
    subject = sanitizeHeader(subject);

    const stuffed = String(html || text || "").split(/\r?\n/).map((l) => (l.startsWith('.') ? '.' + l : l)).join('\n');
    const message = [
      `To: ${to}`,
      `Subject: ${subject}`,
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "",
      stuffed,
    ].join("\n");

    sendmail.stdin.write(message);
    sendmail.stdin.end();

    sendmail.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`sendmail exited ${code}: ${stderr}`));
    });
  });
}

module.exports = {
  createEmailAlias,
  resolveAlias,
  deleteAlias,
  deleteAliasesForAccount,
  sendWithAlias,
  forwardToRealEmail,
};
