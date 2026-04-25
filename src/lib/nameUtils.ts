/**
 * Shared helpers for the redraft-season rankings/projections surfaces.
 *
 * - `normName` — canonical player-name normalizer used when joining
 *   `score-store/*.json` shards in the UI. Lower-cases, strips
 *   punctuation/diacritics, drops Jr/Sr/II/III/IV/V suffixes, and
 *   collapses whitespace.
 *
 * - `boomPct` / `bustPct` — legacy CI-based percent helpers. Kept for
 *   the Rankings tab; new surfaces should prefer the within-position
 *   z-score helpers (`positionStats` + `zScore`).
 *
 * - `positionStats` / `zScore` — compute mean+std per position over an
 *   arbitrary numeric, then z-score a value against its position's
 *   distribution. Used for boom/bust within-position scoring.
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

export interface PosStat { mean: number; std: number }

/**
 * Build per-position {mean, std} from a list of items keyed by position.
 * Skips non-finite values. std falls back to 1 if a position has <2 samples
 * so z-scoring divides safely.
 */
export function positionStats<T>(
  items: T[],
  getPosition: (x: T) => string,
  getValue: (x: T) => number,
): Map<string, PosStat> {
  const buckets = new Map<string, number[]>();
  for (const it of items) {
    const v = getValue(it);
    if (!Number.isFinite(v)) continue;
    const pos = getPosition(it);
    if (!pos) continue;
    const arr = buckets.get(pos);
    if (arr) arr.push(v);
    else buckets.set(pos, [v]);
  }
  const out = new Map<string, PosStat>();
  for (const [pos, arr] of buckets) {
    const mean = arr.reduce((s, x) => s + x, 0) / arr.length;
    const variance = arr.length > 1
      ? arr.reduce((s, x) => s + (x - mean) ** 2, 0) / (arr.length - 1)
      : 0;
    const std = Math.sqrt(variance) || 1;
    out.set(pos, { mean, std });
  }
  return out;
}

export function zScore(value: number, stat: PosStat | undefined): number {
  if (!stat || !Number.isFinite(value)) return 0;
  return (value - stat.mean) / stat.std;
}
