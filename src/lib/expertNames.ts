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
): Promise<Record<string, string> | null> {
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
    const doc = JSON.parse(new TextDecoder().decode(plain)) as { names?: Record<string, string> };
    return doc.names ?? null;
  } catch {
    return null;
  }
}

// Decrypted names persist for the tab's lifetime so a reload doesn't re-prompt.
const SS_KEY = 'expert-names-unlocked';

export function loadCachedUnlockedNames(): Record<string, string> | null {
  try {
    const s = sessionStorage.getItem(SS_KEY);
    return s ? (JSON.parse(s) as Record<string, string>) : null;
  } catch {
    return null;
  }
}

export function cacheUnlockedNames(names: Record<string, string>): void {
  try {
    sessionStorage.setItem(SS_KEY, JSON.stringify(names));
  } catch {
    // storage full/disabled — unlock still works for this render
  }
}
