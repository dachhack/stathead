/**
 * Map predicted PPG to a 0-100 tier score aligned with ZAP's 2026 talent-gap
 * methodology (Legendary / Elite / Weekly Starter / Flex / Bench / Waiver /
 * Dart). Shared by ZAP Compare, Dynasty Prospects, PlayerCard, and the
 * Rookie Career Backtest so "Our Score" is one semantic axis across the app.
 *
 * Position-adjusted benchmarks anchored to ZAP's tier descriptions:
 *   Legendary    90-100: generational talent
 *   Elite        75-90:  top producer
 *   Weekly Start 60-75:  reliable starter
 *   Flex Play    40-60:  occasional starter
 *   Benchwarmer  30-40:  depth
 *   Waiver Wire  20-30:  situational
 *   Dart Throw   0-20:   unlikely to produce
 */

export interface TierBenchmarks {
  leg: number;
  elite: number;
  start: number;
  flex: number;
  bench: number;
  waiver: number;
}

export const TIER_BENCHMARKS: Record<string, TierBenchmarks> = {
  RB: { leg: 16, elite: 13, start: 10, flex: 6, bench: 4, waiver: 2 },
  WR: { leg: 14, elite: 11, start: 8, flex: 5, bench: 3, waiver: 1.5 },
  TE: { leg: 11, elite: 8, start: 6, flex: 4, bench: 2.5, waiver: 1 },
  QB: { leg: 22, elite: 18, start: 15, flex: 11, bench: 8, waiver: 5 },
};

/**
 * Convert predicted PPG to the 0-100 tier score. Returns 0 for missing /
 * non-positive input so "no prediction" renders as 0 (falls through to
 * existing "no data" UI treatment in consumers).
 */
export function ppgToTierScore(ppg: number, pos: string): number {
  if (!ppg || ppg <= 0) return 0;
  const b = TIER_BENCHMARKS[pos] || TIER_BENCHMARKS.WR;
  if (ppg >= b.leg) return Math.min(100, 90 + (ppg - b.leg) * 2);
  if (ppg >= b.elite) return 75 + ((ppg - b.elite) / (b.leg - b.elite)) * 15;
  if (ppg >= b.start) return 60 + ((ppg - b.start) / (b.elite - b.start)) * 15;
  if (ppg >= b.flex) return 40 + ((ppg - b.flex) / (b.start - b.flex)) * 20;
  if (ppg >= b.bench) return 30 + ((ppg - b.bench) / (b.flex - b.bench)) * 10;
  if (ppg >= b.waiver) return 20 + ((ppg - b.waiver) / (b.bench - b.waiver)) * 10;
  return Math.max(0, b.waiver > 0 ? (ppg / b.waiver) * 20 : 0);
}

/**
 * Human-readable tier name for a score. Useful for PlayerCard badges,
 * tooltips, and prospect-view labels.
 */
export function tierName(score: number): string {
  if (score >= 90) return 'Legendary';
  if (score >= 75) return 'Elite';
  if (score >= 60) return 'Weekly Starter';
  if (score >= 40) return 'Flex Play';
  if (score >= 30) return 'Benchwarmer';
  if (score >= 20) return 'Waiver Wire';
  return 'Dart Throw';
}

/**
 * Tier color for UI (same palette used by ZAP Compare / RookieCareerBacktest).
 */
export function tierColor(score: number): string {
  if (score >= 90) return '#22c55e';   // Legendary — green
  if (score >= 75) return '#4ade80';   // Elite — light green
  if (score >= 60) return '#a3e635';   // Weekly Starter — lime
  if (score >= 40) return '#facc15';   // Flex — yellow
  if (score >= 30) return '#fb923c';   // Bench — orange
  if (score >= 20) return '#ef4444';   // Waiver — red
  return '#71717a';                    // Dart — gray
}
