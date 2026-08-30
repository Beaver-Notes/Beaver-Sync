#!/usr/bin/env node
'use strict';

/**
 * Offline HMAC license key generator.
 * Never bundled into Docker image (see .dockerignore).
 *
 * Usage:
 *   LICENSE_SECRET=... node scripts/generate-license.js --licensee "Acme Corp" --expiry 2027-08-30 [--seats 50]
 *   echo '{"licensee":"Acme","expiry":"2027-08-30","seats":50}' | LICENSE_SECRET=... node scripts/generate-license.js --stdin
 *
 * Env:
 *   LICENSE_SECRET - HMAC secret (required, min 16 chars). Also read from stdin JSON if not set.
 * Optional:
 *   LICENSE_SECRET via --secret flag (not recommended, leaks to shell history)
 */

const crypto = require('crypto');
const fs = require('fs');

const GRACE_DAYS = 14;
const PREFIX = 'BL';

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64url');
}

function canonicalStringify(obj) {
  const sorted = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
  return JSON.stringify(sorted);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--stdin') out.stdin = true;
    else if (a === '--licensee' && argv[i + 1]) out.licensee = argv[++i];
    else if (a === '--expiry' && argv[i + 1]) out.expiry = argv[++i];
    else if (a === '--seats' && argv[i + 1]) out.seats = parseInt(argv[++i], 10);
    else if (a === '--secret' && argv[i + 1]) out.secret = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function printHelp() {
  console.log(`Usage: LICENSE_SECRET=... node scripts/generate-license.js --licensee "Name" --expiry YYYY-MM-DD [--seats N]
   or: echo '{"licensee":"Name","expiry":"2027-01-01","seats":10}' | LICENSE_SECRET=... node scripts/generate-license.js --stdin

Format: BL<base64url(payload)>.<base64url(HMAC-SHA256(payload, LICENSE_SECRET))>
Payload canonical JSON: {licensee, plan:'enterprise', seats?, expiry}
Verification is offline HMAC with timing-safe compare, 14d grace after expiry.
`);
}

async function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const secret = args.secret || process.env.LICENSE_SECRET || process.env.LICENSE_SECRET_VALUE;
  if (!secret || secret.length < 16) {
    console.error('ERROR: LICENSE_SECRET not set or too short (min 16 chars). Set env LICENSE_SECRET=...');
    process.exit(1);
  }

  let licensee = args.licensee;
  let expiry = args.expiry;
  let seats = args.seats;

  if (args.stdin) {
    const raw = await readStdin();
    if (!raw.trim()) {
      console.error('ERROR: --stdin expects JSON on stdin');
      process.exit(1);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.error('ERROR: invalid JSON on stdin:', e.message);
      process.exit(1);
    }
    licensee = licensee || parsed.licensee;
    expiry = expiry || parsed.expiry;
    if (parsed.seats !== undefined) seats = parsed.seats;
  } else if (!licensee || !expiry) {
    // also allow ENV-based payload: LICENSEE / EXPIRY / SEATS
    licensee = licensee || process.env.LICENSEE;
    expiry = expiry || process.env.EXPIRY || process.env.LICENSE_EXPIRY;
    if (seats === undefined && process.env.SEATS) seats = parseInt(process.env.SEATS, 10);
    if (seats === undefined && process.env.LICENSE_SEATS) seats = parseInt(process.env.LICENSE_SEATS, 10);
  }

  if (!licensee || typeof licensee !== 'string' || !licensee.trim()) {
    console.error('ERROR: --licensee required');
    printHelp();
    process.exit(1);
  }
  if (!expiry || Number.isNaN(Date.parse(expiry))) {
    console.error('ERROR: --expiry required, valid date string (YYYY-MM-DD or ISO)');
    printHelp();
    process.exit(1);
  }
  if (seats !== undefined && (!Number.isInteger(seats) || seats <= 0)) {
    console.error('ERROR: --seats must be positive integer');
    process.exit(1);
  }

  const payload = { licensee: licensee.trim(), plan: 'enterprise', expiry: String(expiry) };
  if (seats !== undefined) payload.seats = seats;

  const json = canonicalStringify(payload);
  const payloadB64 = b64urlEncode(json);
  const sig = crypto.createHmac('sha256', secret).update(payloadB64).digest();
  const sigB64 = b64urlEncode(sig);
  const key = `${PREFIX}${payloadB64}.${sigB64}`;

  // Output: key only to stdout; metadata to stderr
  console.log(key);
  console.error(`[license] licensee=${payload.licensee} expiry=${payload.expiry} seats=${payload.seats ?? 'unlimited'} grace=${GRACE_DAYS}d`);
}

main().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
