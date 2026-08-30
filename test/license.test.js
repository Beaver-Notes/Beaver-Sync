'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SECRET = 'test-license-secret-min-32-chars-long!!';
const FUTURE = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const PAST_5D = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const PAST_20D = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const SOON_5D = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

function withEnv(env, fn) {
  const prev = {};
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    // clear require cache for license to pick up new env
    delete require.cache[require.resolve('../src/lib/license')];
    return fn(require('../src/lib/license'));
  } finally {
    for (const k of Object.keys(env)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    delete require.cache[require.resolve('../src/lib/license')];
  }
}

test('format BL<base64url(payload)>.<base64url(HMAC)> and canonical JSON', () => {
  withEnv({ LICENSE_SECRET: SECRET }, (lic) => {
    const key = lic.generateLicenseKey({ licensee: 'Acme Corp', expiry: FUTURE, seats: 10 });
    assert.ok(key.startsWith('BL'), 'prefix BL');
    const rest = key.slice(2);
    const dot = rest.indexOf('.');
    assert.ok(dot > 0, 'contains dot');
    const payloadB64 = rest.slice(0, dot);
    const sigB64 = rest.slice(dot + 1);
    // payload is canonical JSON sorted keys
    const jsonStr = lic.b64urlDecode(payloadB64).toString('utf8');
    const payload = JSON.parse(jsonStr);
    assert.equal(payload.licensee, 'Acme Corp');
    assert.equal(payload.plan, 'enterprise');
    assert.equal(payload.seats, 10);
    assert.equal(payload.expiry, FUTURE);
    // canonical ordering: licensee, plan, seats, expiry sorted -> expiry, licensee, plan, seats? check sorted
    const keys = Object.keys(payload);
    // JSON parsed order not guaranteed sorted, but canonicalStringify sorts
    const canonical = lic.canonicalStringify(payload);
    assert.equal(canonical, JSON.stringify({ expiry: FUTURE, licensee: 'Acme Corp', plan: 'enterprise', seats: 10 }));

    // same payload different key order must produce same signature (canonical)
    const payload2 = { seats: 10, expiry: FUTURE, plan: 'enterprise', licensee: 'Acme Corp' };
    const json2 = lic.canonicalStringify(payload2);
    assert.equal(json2, canonical);
    const payloadB642 = lic.b64urlEncode(json2);
    assert.equal(payloadB642, payloadB64);

    // HMAC is over payloadB64
    const expectedSig = crypto.createHmac('sha256', SECRET).update(payloadB64).digest();
    const actualSig = lic.b64urlDecode(sigB64);
    assert.deepEqual(actualSig, expectedSig);
  });
});

test('verifyLicense timing-safe and rejects tampered payload/signature', () => {
  withEnv({ LICENSE_SECRET: SECRET, LICENSE_KEY: '' }, (lic) => {
    const key = lic.generateLicenseKey({ licensee: 'Acme', expiry: FUTURE });
    const res = lic.verifyLicense(key);
    assert.equal(res.valid, true);

    // tampered signature: flip last char
    const tamperedSig = key.slice(0, -1) + (key.slice(-1) === 'A' ? 'B' : 'A');
    assert.equal(lic.verifyLicense(tamperedSig).valid, false);
    assert.equal(lic.verifyLicense(tamperedSig).reason, 'bad_signature');

    // tampered payload: change licensee in b64 without updating sig
    const rest = key.slice(2);
    const dot = rest.indexOf('.');
    const payloadB64 = rest.slice(0, dot);
    const sigB64 = rest.slice(dot + 1);
    const payload = JSON.parse(lic.b64urlDecode(payloadB64).toString('utf8'));
    payload.licensee = 'Evil Corp';
    const evilPayloadB64 = lic.b64urlEncode(lic.canonicalStringify(payload));
    const evilKey = `BL${evilPayloadB64}.${sigB64}`;
    const evilRes = lic.verifyLicense(evilKey);
    assert.equal(evilRes.valid, false);
    assert.equal(evilRes.reason, 'bad_signature');

    // wrong secret fails
    withEnv({ LICENSE_SECRET: 'different-secret-min-32-chars-long!!' }, (lic2) => {
      assert.equal(lic2.verifyLicense(key).valid, false);
    });

    // bad prefix
    assert.equal(lic.verifyLicense(key.replace('BL', 'XX')).valid, false);
    // bad format
    assert.equal(lic.verifyLicense('BLno-dot-here').valid, false);
    // bad plan
    const badPlanPayload = lic.canonicalStringify({ licensee: 'Acme', plan: 'free', expiry: FUTURE });
    const badPlanB64 = lic.b64urlEncode(badPlanPayload);
    const badPlanSig = lic.b64urlEncode(crypto.createHmac('sha256', SECRET).update(badPlanB64).digest());
    const badPlanKey = `BL${badPlanB64}.${badPlanSig}`;
    assert.equal(lic.verifyLicense(badPlanKey).valid, false);
    assert.equal(lic.verifyLicense(badPlanKey).reason, 'bad_plan');
  });
});

test('expiry handling: valid, grace (14d), expired beyond grace', () => {
  withEnv({ LICENSE_SECRET: SECRET }, (lic) => {
    const validKey = lic.generateLicenseKey({ licensee: 'Acme', expiry: FUTURE });
    const validRes = lic.verifyLicense(validKey);
    assert.equal(validRes.valid, true);
    assert.equal(validRes.inGrace, false);

    const graceKey = lic.generateLicenseKey({ licensee: 'Acme', expiry: PAST_5D });
    const graceRes = lic.verifyLicense(graceKey);
    assert.equal(graceRes.valid, true, 'within 14d grace should still be valid');
    assert.equal(graceRes.inGrace, true);
    assert.ok(graceRes.graceDaysLeft > 0 && graceRes.graceDaysLeft <= 14);

    const expiredKey = lic.generateLicenseKey({ licensee: 'Acme', expiry: PAST_20D });
    const expiredRes = lic.verifyLicense(expiredKey);
    assert.equal(expiredRes.valid, false);
    assert.equal(expiredRes.reason, 'expired');
  });
});

test('14d grace warning: expiringSoon flag within 14d before expiry', () => {
  withEnv({ LICENSE_SECRET: SECRET }, (lic) => {
    const soonKey = lic.generateLicenseKey({ licensee: 'Acme', expiry: SOON_5D });
    const soonRes = lic.verifyLicense(soonKey);
    assert.equal(soonRes.valid, true);
    assert.equal(soonRes.expiringSoon, true);

    const futureRes = lic.verifyLicense(lic.generateLicenseKey({ licensee: 'Acme', expiry: FUTURE }));
    assert.equal(futureRes.expiringSoon, false);
  });
});

test('seats soft-warn: license valid regardless of seats, checkSeats warns', () => {
  withEnv({ LICENSE_SECRET: SECRET, LICENSE_KEY: '' }, (lic) => {
    const key = lic.generateLicenseKey({ licensee: 'Acme', expiry: FUTURE, seats: 5 });
    assert.equal(lic.verifyLicense(key).valid, true);
    // set env key for checkSeats
    process.env.LICENSE_KEY = key;
    delete require.cache[require.resolve('../src/lib/license')];
    const lic2 = require('../src/lib/license');
    assert.equal(lic2.checkSeats(3).warn, false);
    assert.equal(lic2.checkSeats(6).warn, true);
    assert.equal(lic2.checkSeats(6).licensedSeats, 5);
    delete process.env.LICENSE_KEY;

    // unlimited seats (no seats field) never warns
    const unlimitedKey = lic.generateLicenseKey({ licensee: 'Acme', expiry: FUTURE });
    process.env.LICENSE_KEY = unlimitedKey;
    delete require.cache[require.resolve('../src/lib/license')];
    const lic3 = require('../src/lib/license');
    assert.equal(lic3.checkSeats(9999).warn, false);
    delete process.env.LICENSE_KEY;
  });
});

test('production gate precedence: ENTERPRISE_MODE alone insufficient in prod', () => {
  const futureKey = withEnv({ LICENSE_SECRET: SECRET }, (lic) => lic.generateLicenseKey({ licensee: 'Acme', expiry: FUTURE }));
  // dev: ENTERPRISE_MODE alone is enterprise
  withEnv({ ENTERPRISE_MODE: 'true', NODE_ENV: 'development', LICENSE_SECRET: SECRET, LICENSE_KEY: '' }, (lic) => {
    assert.equal(lic.isEnterpriseMode(), true, 'dev ENTERPRISE_MODE true should be enterprise even without license');
  });
  // prod without license -> not enterprise
  withEnv({ ENTERPRISE_MODE: 'true', NODE_ENV: 'production', LICENSE_SECRET: SECRET, LICENSE_KEY: '' }, (lic) => {
    assert.equal(lic.isEnterpriseMode(), false, 'prod without license should not be enterprise');
  });
  // prod with valid license -> enterprise
  withEnv({ ENTERPRISE_MODE: 'true', NODE_ENV: 'production', LICENSE_SECRET: SECRET, LICENSE_KEY: futureKey }, (lic) => {
    assert.equal(lic.isEnterpriseMode(), true, 'prod with valid license should be enterprise');
  });
  // prod with expired beyond grace -> not enterprise
  const expiredKey = withEnv({ LICENSE_SECRET: SECRET }, (lic) => lic.generateLicenseKey({ licensee: 'Acme', expiry: PAST_20D }));
  withEnv({ ENTERPRISE_MODE: 'true', NODE_ENV: 'production', LICENSE_SECRET: SECRET, LICENSE_KEY: expiredKey }, (lic) => {
    assert.equal(lic.isEnterpriseMode(), false, 'prod with expired license should not be enterprise');
  });
  // prod with grace license -> still enterprise
  const graceKey = withEnv({ LICENSE_SECRET: SECRET }, (lic) => lic.generateLicenseKey({ licensee: 'Acme', expiry: PAST_5D }));
  withEnv({ ENTERPRISE_MODE: 'true', NODE_ENV: 'production', LICENSE_SECRET: SECRET, LICENSE_KEY: graceKey }, (lic) => {
    assert.equal(lic.isEnterpriseMode(), true, 'prod with grace license should still be enterprise');
  });
  // not enterprise when flag false even with license
  withEnv({ ENTERPRISE_MODE: 'false', NODE_ENV: 'production', LICENSE_SECRET: SECRET, LICENSE_KEY: futureKey }, (lic) => {
    assert.equal(lic.isEnterpriseMode(), false);
  });
});

test('only license.js reads LICENSE_SECRET at runtime', () => {
  const srcDir = path.join(__dirname, '..', 'src');
  const files = [];
  function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.js')) files.push(p);
    }
  }
  walk(srcDir);
  const offenders = [];
  for (const f of files) {
    const content = fs.readFileSync(f, 'utf8');
    if (f.endsWith('src/lib/license.js')) continue;
    if (content.includes('LICENSE_SECRET')) offenders.push(path.relative(path.join(__dirname, '..'), f));
  }
  assert.equal(offenders.length, 0, `Only license.js should read LICENSE_SECRET, found in: ${offenders.join(', ')}`);
});

test('generator never bundled: .dockerignore excludes scripts/generate-license.js', () => {
  const dockerignore = fs.readFileSync(path.join(__dirname, '..', '.dockerignore'), 'utf8');
  assert.ok(dockerignore.includes('scripts/generate-license.js'), '.dockerignore must exclude generator');
});

test('generator stdin/ENV produces verifiable key', () => {
  const genPath = path.join(__dirname, '..', 'scripts/generate-license.js');
  const payload = JSON.stringify({ licensee: 'Stdin Corp', expiry: FUTURE, seats: 3 });
  const result = spawnSync(process.execPath, [genPath, '--stdin'], {
    input: payload,
    env: { ...process.env, LICENSE_SECRET: SECRET },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `generator failed: ${result.stderr}`);
  const key = result.stdout.trim().split('\n')[0].trim();
  assert.ok(key.startsWith('BL'), 'generated key prefix');

  withEnv({ LICENSE_SECRET: SECRET }, (lic) => {
    const res = lic.verifyLicense(key);
    assert.equal(res.valid, true);
    assert.equal(res.payload.licensee, 'Stdin Corp');
    assert.equal(res.payload.seats, 3);
  });

  // ENV mode
  const result2 = spawnSync(process.execPath, [genPath, '--licensee', 'Env Corp', '--expiry', FUTURE, '--seats', '7'], {
    env: { ...process.env, LICENSE_SECRET: SECRET },
    encoding: 'utf8',
  });
  assert.equal(result2.status, 0, `generator env mode failed: ${result2.stderr}`);
  const key2 = result2.stdout.trim().split('\n')[0].trim();
  withEnv({ LICENSE_SECRET: SECRET }, (lic) => {
    assert.equal(lic.verifyLicense(key2).valid, true);
  });
});

test('canonical JSON: same licensee different field order same key verified', () => {
  withEnv({ LICENSE_SECRET: SECRET }, (lic) => {
    const key = lic.generateLicenseKey({ licensee: 'OrderTest', expiry: FUTURE, seats: 2 });
    // Manually craft payload with different order but same canonical
    const altPayload = { expiry: FUTURE, seats: 2, plan: 'enterprise', licensee: 'OrderTest' };
    const altJson = lic.canonicalStringify(altPayload);
    const altB64 = lic.b64urlEncode(altJson);
    const sig = crypto.createHmac('sha256', SECRET).update(altB64).digest();
    const altKey = `BL${altB64}.${lic.b64urlEncode(sig)}`;
    assert.equal(key, altKey, ' canonical ordering makes keys identical');
    assert.equal(lic.verifyLicense(altKey).valid, true);
  });
});
