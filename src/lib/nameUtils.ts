/**
 * Shared helpers for the redraft-season rankings/projections surfaces.
 *
 * - `normName` — canonical player-name normalizer used when joining
 *   `score-store/*.json` shards in the UI. Lower-cases, strips
 *   punctuation/diacritics, drops Jr/Sr/II/III/IV/V suffixes, and
 *   collapses whitespace. Stricter than the `normalizeName` in
 *   `featureTypes.ts` (which preserves dashes and collapses three-part
 *   names); this one is tuned for shard joins where both sides are
 *   hand-typed NFL/rookie names.
 *
 * - `boomPct` / `bustPct` — CI-based spread helpers used by MyRankings
 *   and the Rankings tab. Divides by VOR with a PPG floor so deep-bench
 *   players don't read as ±100%, and clamps to [0, 99].
 *
 * - `stripStarPrefix` — scenario-tag stripper for names prefixed with
 *   "★ " (used by projection tables to mark free-agent / custom players).
 */

export function normName(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .toLowerCase()
    .replace(/[^a-z ]/g, '')
    .replace(/\s+(jr|sr|ii|iii|iv|v)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Small-VOR players (≤ this floor) use the floor as the denominator so
// a ±2 PPG CI doesn't render as ±100%.
const VOR_DENOM_FLOOR = 5;
const PCT_CLAMP_MAX = 99;

export function boomPct(vor: number, ciUpper: number): number {
  if (!vor || !Number.isFinite(vor) || !Number.isFinite(ciUpper)) return 0;
  const denom = Math.max(vor, VOR_DENOM_FLOOR);
  const raw = Math.round(((ciUpper - vor) / denom) * 100);
  if (raw <= 0) return 0;
  return Math.min(PCT_CLAMP_MAX, raw);
}

export function bustPct(vor: number, ciLower: number): number {
  if (!vor || !Number.isFinite(vor) || !Number.isFinite(ciLower)) return 0;
  const denom = Math.max(vor, VOR_DENOM_FLOOR);
  const raw = Math.round(((vor - ciLower) / denom) * 100);
  if (raw <= 0) return 0;
  return Math.min(PCT_CLAMP_MAX, raw);
}

export function stripStarPrefix(name: string): string {
  return name.replace(/^★\s*/, '');
}
