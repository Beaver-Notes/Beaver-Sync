"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const mlkem = require("mlkem");

const MLKEM_SEED_PATH =
  process.env.MLKEM_SEED_PATH ||
  path.join(__dirname, "..", "..", "keys", "mlkem-seed.hex");
const MLKEM_VARIANT = "ML-KEM-768";

let instance = null;
let publicKey = null;
let privateKey = null;

async function init() {
  if (instance) return;

  instance = await mlkem.createMlKem768();

  let seedHex = process.env.MLKEM_SEED;

  if (!seedHex) {
    try {
      seedHex = fs.readFileSync(MLKEM_SEED_PATH, "utf8").trim();
    } catch {
      const seed = crypto.randomBytes(64);
      seedHex = seed.toString("hex");

      const dir = path.dirname(MLKEM_SEED_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(MLKEM_SEED_PATH, seedHex + "\n", { mode: 0o600 });
      console.log(`[mlkem] Generated new key seed -> ${MLKEM_SEED_PATH}`);
    }
  }

  const seed = Buffer.from(seedHex, "hex");
  if (seed.length !== 64) {
    throw new Error(
      `MLKEM_SEED must be 64 bytes (128 hex chars), got ${seed.length}`,
    );
  }

  [publicKey, privateKey] = await instance.deriveKeyPair(seed);
  console.log(
    `[mlkem] ML-KEM-768 initialized (pk: ${publicKey.length}B, sk: ${privateKey.length}B)`,
  );
}

function requireReady() {
  if (!instance) throw new Error("ML-KEM not initialized - call init() first");
}

function getPublicKey() {
  requireReady();
  return Buffer.from(publicKey);
}

async function wrapBlob(plaintext) {
  requireReady();
  const input = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext);

  const [kemCt, sharedSecret] = await instance.encap(publicKey);

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    Buffer.from(sharedSecret),
    iv,
  );
  const ct = Buffer.concat([cipher.update(input), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.from(
    JSON.stringify({
      v: 1,
      kem: MLKEM_VARIANT,
      kemCt: Buffer.from(kemCt).toString("base64"),
      iv: iv.toString("base64"),
      ct: ct.toString("base64"),
      tag: tag.toString("base64"),
    }),
    "utf8",
  );
}

async function unwrapBlob(envelope) {
  requireReady();
  const data = Buffer.isBuffer(envelope) ? envelope : Buffer.from(envelope);
  const parsed = JSON.parse(data.toString("utf8"));

  if (parsed.v !== 1 || parsed.kem !== MLKEM_VARIANT) {
    throw new Error(
      `Unsupported ML-KEM envelope: v=${parsed.v} kem=${parsed.kem}`,
    );
  }

  const sharedSecret = await instance.decap(
    Buffer.from(parsed.kemCt, "base64"),
    privateKey,
  );

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    Buffer.from(sharedSecret),
    Buffer.from(parsed.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(parsed.ct, "base64")),
    decipher.final(),
  ]);
}

async function encryptMetadata(plaintext) {
  const buf = await wrapBlob(Buffer.from(plaintext, "utf8"));
  return buf.toString("utf8");
}

async function decryptMetadata(envelope) {
  const buf = await unwrapBlob(Buffer.from(envelope, "utf8"));
  return buf.toString("utf8");
}

module.exports = {
  init,
  getPublicKey,
  wrapBlob,
  unwrapBlob,
  encryptMetadata,
  decryptMetadata,
};
