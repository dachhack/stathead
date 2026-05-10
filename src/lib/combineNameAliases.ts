// Manual aliases for combine `player_name` values that don't match the
// canonical prospect-store / prospect-grades spelling after normalization.
// PFR sometimes carries a player's legal name with a hyphenated middle name
// (e.g. "De'Zhaun-Ryan Stribling"), which strips to "dezhaunryan stribling"
// and never matches "dezhaun stribling" coming from the prospect-store.
// Without this map the prospect appears twice in the rookie list — once
// from the combine pass and once from the graded-prospects fallback pass.
//
// Add new entries when a similar mismatch surfaces. Key = upstream combine
// name; value = canonical prospect-store name.
export const COMBINE_NAME_ALIASES: Record<string, string> = {
  "De'Zhaun-Ryan Stribling": "De'Zhaun Stribling",
};

// Returns the canonical name for a combine record's player_name, falling
// back to the original when no alias is registered.
export function aliasCombineName(name: string): string {
  return COMBINE_NAME_ALIASES[name] || name;
}
