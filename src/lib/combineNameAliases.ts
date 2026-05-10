// Cross-source player-name aliases.
//
// Different upstream feeds spell the same player differently:
//   - PFR carries legal names with hyphenated middles ("De'Zhaun-Ryan Stribling")
//   - FantasyPros uses common-name forms ("Nick Singleton")
//   - Prospect grades / KTC / nflverse use a third spelling ("Nicholas Singleton")
//
// Without canonicalization, normalizeName produces different keys for each
// spelling, so the same prospect appears multiple times in the rookie list
// (combine pass emits one row, FP fallback emits a second).
//
// Pick ONE canonical spelling per player (typically whichever appears in
// `prospect-grades-2026.json`) and map every other source spelling to it.
// All view-side map builders should call `canonicalizePlayerName` before
// normalizing, so every source keys onto the same string.

const PLAYER_NAME_ALIASES: Record<string, string> = {
  // PFR legal name → prospect-store form (combine join)
  "De'Zhaun-Ryan Stribling": "De'Zhaun Stribling",
  // FantasyPros common form → prospect-grades / KTC form (rookie list dedupe)
  "Nick Singleton": "Nicholas Singleton",
};

export function canonicalizePlayerName(name: string): string {
  return PLAYER_NAME_ALIASES[name] || name;
}

// Backwards-compat exports for the combine-only call sites that imported
// the older module name. Both alias the same underlying map now.
export const COMBINE_NAME_ALIASES = PLAYER_NAME_ALIASES;
export const aliasCombineName = canonicalizePlayerName;
