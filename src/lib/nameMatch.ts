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
 *  roster-name joins against KTC / Sleeper, where spacing/punctuation varies
 *  but the letter sequence is stable. */
export function normalizeForMatch(name: string): string {
  return name.toLowerCase().replace(/[^a-z]/g, '').replace(/^(jr|sr|ii|iii|iv)$/, '');
}

/** Lowercase, keep only a-z and spaces (drops digits, punctuation, accents
 *  wholesale), collapse whitespace. The light-touch matcher used by the KTC /
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
 *  across combine / FantasyPros / KTC feeds, drop generational suffixes
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
