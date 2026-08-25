/**
 * Shared player-name normalizers for fuzzy matching across data sources.
 *
 * These existed as byte-identical copy-paste in a dozen components; collected
 * here so they can't drift. They are deliberately DISTINCT from
 * `normalizeName` in featureTypes.ts (which additionally collapses 3+ word
 * names to first+last and applies nickname aliases) — these are simpler,
 * behavior-preserving matchers. Pick the one whose stripping rules match the
 * index you're joining against; don't swap them blindly, as each yields
 * different keys.
 */

/** Alpha-only, space-insensitive key (strips spaces too). Used for exact
 *  roster-name joins against Dynasty / Sleeper, where spacing/punctuation varies
 *  but the letter sequence is stable.
 *
 *  The generational suffix is stripped while word boundaries still exist. The
 *  previous implementation ran /^(jr|sr|ii|iii|iv)$/ AFTER spaces were removed
 *  and anchored it to the whole string, so it could never fire: "Kenneth
 *  Walker III" keyed as "kennethwalkeriii" and missed the roster's "Kenneth
 *  Walker" entirely. Every consumer read that miss as "no dynasty value",
 *  which the waiver tool then treated as a zero-value player and offered up
 *  as its top drop candidate. */
export function normalizeForMatch(name: string): string {
  return (name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/[^a-z]/g, '');
}

/** Last name + first initial ("Chigoziem Okonkwo" and "Chig Okonkwo" both →
 *  "okonkwoc"). A deliberately loose key for the nickname axis that no
 *  suffix rule can reach — sources disagree on Chig/Chigoziem, Kenny/Kenneth,
 *  Mike/Michael. Returns '' when a name has no two parts to key on.
 *
 *  Loose enough to collide (Bijan vs Brian Robinson, Jonathan vs J'Mari
 *  Taylor — 26 such keys on a 500-player dynasty board), so it is only safe
 *  via buildFallbackIndex, which drops every ambiguous key rather than
 *  guessing between two real players. */
export function fallbackNameKey(name: string): string {
  const parts = (name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/[^a-z ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length < 2) return '';
  return `${parts[parts.length - 1]}${parts[0][0]}`;
}

/** Index items under fallbackNameKey, keeping ONLY keys that resolve to a
 *  single item. An ambiguous key maps to null so callers fall through to "no
 *  match" instead of silently binding the wrong player's value. */
export function buildFallbackIndex<T>(items: Iterable<T>, nameOf: (item: T) => string): Map<string, T | null> {
  const index = new Map<string, T | null>();
  for (const item of items) {
    const key = fallbackNameKey(nameOf(item));
    if (!key) continue;
    index.set(key, index.has(key) ? null : item);
  }
  return index;
}

/** Lowercase, keep only a-z and spaces (drops digits, punctuation, accents
 *  wholesale), collapse whitespace. The light-touch matcher used by the Dynasty /
 *  career name joins. */
export function normalizeNameSimple(name: string | null | undefined): string {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/[^a-z ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Accent-aware matcher: Unicode-decompose then drop combining marks (e-acute
 *  -> e, n-tilde -> n), strip the punctuation/apostrophe variants that differ
 *  across combine / FantasyPros / Dynasty feeds, drop generational suffixes
 *  anywhere, and collapse whitespace. Used by the rookie/prospect views that
 *  join noisy multi-source name strings. */
export function normalizeNameUnicode(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.\-'\u2018\u2019\u201A\u201B\u2032`\u00B4]/g, '')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
