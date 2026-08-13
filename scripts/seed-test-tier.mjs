#!/usr/bin/env node
// Seed a single test account + subscription for manual verification against
// the test compose stack or the local test database.
//
// Usage: node scripts/seed-test-tier.mjs <plan> <email> <password>
//   plan      one of: free, starter, pro, team, enterprise   (default: free)
//   email     account email, hashed the same way as tests     (default: tester@example.com)
//   password  login password                                   (default: TestPassword123!)
//
// Requires DATABASE_URL (defaults to the local dev Postgres) and EMAIL_HMAC_KEY
// (defaults to the test-suite key). The account gets an active subscription at
// the requested tier.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const [plan = 'free', email = 'tester@example.com', password = 'TestPassword123!'] = process.argv.slice(2);

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://beaver:beaver@localhost:5432/beaver';
process.env.EMAIL_HMAC_KEY = process.env.EMAIL_HMAC_KEY || 'test-email-hmac-key-at-least-32-characters-long';

const { VALID_PLANS } = require(path.join(repoRoot, 'src', 'lib', 'plans'));
const { Account, Subscription } = require(path.join(repoRoot, 'src', 'models'));
const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const { close } = require(path.join(repoRoot, 'src', 'db'));

if (!VALID_PLANS.has(plan)) {
  console.error(`Invalid plan "${plan}". Valid plans: ${[...VALID_PLANS].sort().join(', ')}`);
  process.exit(1);
}

if (Buffer.byteLength(password, 'utf8') > 72) {
  console.error('Password must be at most 72 bytes (bcrypt limit).');
  process.exit(1);
}

function createEmailHash(raw) {
  const normalized = String(raw).trim().toLowerCase();
  return crypto.createHmac('sha256', process.env.EMAIL_HMAC_KEY).update(normalized).digest('hex');
}

(async () => {
  const emailHash = createEmailHash(email);
  const existing = await Account.findOne({ emailHmac: emailHash }).lean();
  if (existing) {
    console.log(`Account for ${email} already exists (id ${existing.id}); not re-seeding.`);
    process.exit(0);
  }

  const account = await Account.create({
    emailHmac: emailHash,
    emailEncrypted: 'e',
    passwordHash: await bcrypt.hash(password, 12),
    kdfSalt: crypto.randomBytes(32).toString('hex'),
  });

  await Subscription.create({
    accountId: account.id,
    plan,
    status: 'active',
    storageQuotaBytes: 10 * 1024 ** 3,
    storageUsedBytes: 0,
  });

  console.log(`Created account ${account.id} as ${plan}`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
}).finally(() => close().catch(() => {}));
