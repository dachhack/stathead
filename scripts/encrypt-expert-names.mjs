#!/usr/bin/env node
// Encrypt the local-only expert name map (public/data/expert-names.json,
// gitignored) into public/data/expert-names.enc.json, which IS committed and
// deployed. The site's Social Graph offers an "unlock" field that decrypts it
// in-browser via WebCrypto (see src/lib/expertNames.ts).
//
// The ciphertext is world-readable on the deployed site, so the only thing
// standing between the public and the username list is the passphrase —
// offline brute force is possible. Use a long one.
//
// Usage:  node scripts/encrypt-expert-names.mjs <passphrase>
//   or:   EXPERT_NAMES_PASSPHRASE=... node scripts/encrypt-expert-names.mjs
// Run after scripts/build_expert_data.py regenerates expert-names.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { pbkdf2Sync, randomBytes, createCipheriv } from 'node:crypto';

const IN = 'public/data/expert-names.json';
const OUT = 'public/data/expert-names.enc.json';
const ITERATIONS = 600_000; // PBKDF2-SHA256; mirrored by the in-browser decrypt

const pass = process.env.EXPERT_NAMES_PASSPHRASE || process.argv[2];
if (!pass) {
  console.error('usage: node scripts/encrypt-expert-names.mjs <passphrase>  (or set EXPERT_NAMES_PASSPHRASE)');
  process.exit(1);
}
if (pass.length < 12) {
  console.error('passphrase too short: the ciphertext ships publicly, use 12+ characters');
  process.exit(1);
}

let plain;
try {
  plain = readFileSync(IN);
  JSON.parse(plain.toString()); // sanity-check it's the JSON name map
} catch (e) {
  console.error(`cannot read ${IN} — run scripts/build_expert_data.py first (${e.message})`);
  process.exit(1);
}

const salt = randomBytes(16);
const iv = randomBytes(12);
const key = pbkdf2Sync(pass, salt, ITERATIONS, 32, 'sha256');
const cipher = createCipheriv('aes-256-gcm', key, iv);
// WebCrypto's AES-GCM expects ciphertext||authTag as one buffer.
const ct = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);

writeFileSync(OUT, JSON.stringify({
  v: 1,
  kdf: 'PBKDF2-SHA256',
  iter: ITERATIONS,
  salt: salt.toString('base64'),
  iv: iv.toString('base64'),
  ct: ct.toString('base64'),
}));
console.error(`wrote ${OUT} (${ct.length}B ciphertext, ${ITERATIONS} KDF iterations) — commit it to deploy`);
