// Unlock the expert name map on the deployed site. The map (index → Sleeper
// username) never ships in plaintext — scripts/encrypt-expert-names.mjs
// commits a passphrase-encrypted blob, and this module decrypts it in-browser
// with WebCrypto. Parameters (PBKDF2-SHA256 → AES-256-GCM, ct||tag) must stay
// in sync with the script.

export interface EncryptedNames {
  v: number;
  kdf: string;
  iter: number;
  salt: string; // base64
  iv: string;   // base64
  ct: string;   // base64, ciphertext || GCM auth tag
}

// Decrypted payload = the gitignored expert-names.json written by
// scripts/build_expert_data.py. All keys are stringified indices into the
// corresponding anonymized public JSON.
export interface ExpertNamesDoc {
  names?: Record<string, string>;      // expert index → Sleeper username
  candidates?: Record<string, string>; // candidate index → Sleeper username
  leagues?: Record<string, string>;    // league-graph node index → league name
}

const b64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Null when the encrypted blob isn't deployed (owner hasn't run the encrypt script). */
export async function fetchEncryptedNames(): Promise<EncryptedNames | null> {
  try {
    const r = await fetch(`${import.meta.env.BASE_URL}data/expert-names.enc.json`);
    if (!r.ok) return null;
    const doc = (await r.json()) as EncryptedNames;
    return doc && doc.v === 1 && doc.ct ? doc : null;
  } catch {
    return null;
  }
}

/** Null on a wrong passphrase (GCM auth fails) or malformed blob. */
export async function decryptExpertNames(
  enc: EncryptedNames,
  passphrase: string,
): Promise<ExpertNamesDoc | null> {
  try {
    const keyMaterial = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey'],
    );
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: b64(enc.salt) as BufferSource, iterations: enc.iter },
      keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
    );
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64(enc.iv) as BufferSource }, key, b64(enc.ct) as BufferSource,
    );
    const doc = JSON.parse(new TextDecoder().decode(plain)) as ExpertNamesDoc;
    return doc.names ? doc : null;
  } catch {
    return null;
  }
}

// The decrypted doc persists for the tab's lifetime so a reload doesn't re-prompt.
const SS_KEY = 'expert-names-unlocked';

export function loadCachedUnlockedNames(): ExpertNamesDoc | null {
  try {
    const s = sessionStorage.getItem(SS_KEY);
    if (!s) return null;
    const doc = JSON.parse(s) as ExpertNamesDoc | Record<string, string>;
    // Pre-candidates cache entries were the flat names map itself.
    return 'names' in doc ? (doc as ExpertNamesDoc) : { names: doc as Record<string, string> };
  } catch {
    return null;
  }
}

export function cacheUnlockedNames(doc: ExpertNamesDoc): void {
  try {
    sessionStorage.setItem(SS_KEY, JSON.stringify(doc));
  } catch {
    // storage full/disabled — unlock still works for this render
  }
}
