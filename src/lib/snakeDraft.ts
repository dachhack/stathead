/**
 * Snake-draft pick math + ADP-survival probability.
 *
 * Used by the Edge Board's "available at my picks" filter and by the
 * Round-by-Round Plan section. Survival uses a Gaussian model on the FFC
 * `stdev` field (per-player ADP volatility), since FFC is the canonical
 * ADP source for this app. FFC's σ tightens late in draft season — known
 * limitation, may revisit with empirically-fit σ if the Gaussian model
 * produces weird recommendations.
 */

import type { DraftType } from './draftPrepSettings';

/**
 * Pick number for a given round (1-indexed) given the user's slot and
 * league size. Snake reverses every other round; linear keeps the same
 * slot every round.
 */
export function pickNumber(round: number, slot: number, numTeams: number, draftType: DraftType): number {
  const base = (round - 1) * numTeams;
  if (draftType === 'linear') return base + slot;
  // Snake: odd rounds go 1→N, even rounds go N→1.
  return round % 2 === 1 ? base + slot : base + (numTeams - slot + 1);
}

/** All of the user's pick numbers for the first `rounds` rounds. */
export function userPickNumbers(rounds: number, slot: number, numTeams: number, draftType: DraftType): number[] {
  const out: number[] = [];
  for (let r = 1; r <= rounds; r++) out.push(pickNumber(r, slot, numTeams, draftType));
  return out;
}

/** Abramowitz & Stegun 26.2.17 normal CDF, accurate to ~7.5e-8. */
function normCdf(z: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

/**
 * P(player still undrafted at pick N), modeled as the player's true draft
 * pick being distributed N(adp, stdev). With no stdev (early draft season,
 * or rookie with sparse data), default to 8 picks of σ — roughly a
 * half-round window in 12-team.
 */
export function survivalAtPick(adp: number, stdev: number | undefined | null, pickN: number): number {
  if (!Number.isFinite(adp) || adp <= 0) return 0;
  const sigma = Number.isFinite(stdev) && (stdev as number) > 0.5 ? (stdev as number) : 8;
  // P(true draft pick > N) = 1 − Φ((N − adp) / σ).
  return 1 - normCdf((pickN - adp) / sigma);
}

/**
 * Best survival probability across any of the user's picks. A player is
 * "in the user's window" if there's any pick where they're plausibly
 * available — useful for filtering the Edge Board to "players I might
 * actually draft."
 */
export function maxSurvival(adp: number, stdev: number | undefined | null, pickNumbers: number[]): number {
  let best = 0;
  for (const N of pickNumbers) {
    const p = survivalAtPick(adp, stdev, N);
    if (p > best) best = p;
  }
  return best;
}
