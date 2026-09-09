/**
 * Contract lookups that respect the season being scored.
 *
 * The feature pipeline used to keep ONE contract per player — the latest
 * signed — and apply it to every training season. While the nflverse CSV
 * was frozen at 2022 signings that leaked nothing (there was nothing newer
 * to leak), but with a live feed a 2023 training row would see the player's
 * 2026 extension. `contractForSeason` returns the most recent deal signed
 * ON OR BEFORE the season instead, so training rows only ever see what was
 * knowable at the time and `contractYearsRemaining` reflects that deal.
 */

import type { Contract } from '../types';
import { normalizeName } from './featureTypes';

export type ContractsByName = Map<string, Contract[]>;

const SKILL_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);

/** Index contracts by normalized player name, newest signing first. */
export function indexContracts(
  contracts: Contract[],
  positions: Set<string> = SKILL_POSITIONS,
): ContractsByName {
  const byName: ContractsByName = new Map();
  for (const c of contracts) {
    if (!c || !c.player) continue;
    if (positions.size > 0 && !positions.has(String(c.position).toUpperCase())) continue;
    const name = normalizeName(c.player);
    if (!name) continue;
    const list = byName.get(name);
    if (list) list.push(c);
    else byName.set(name, [c]);
  }
  for (const list of byName.values()) list.sort(compareNewestFirst);
  return byName;
}

function compareNewestFirst(a: Contract, b: Contract): number {
  const ya = Number(a.year_signed) || 0;
  const yb = Number(b.year_signed) || 0;
  if (yb !== ya) return yb - ya;
  // Same signing year (a restructure and its replacement, a rookie deal and
  // an in-season extension): the one OverTheCap still marks active wins,
  // then the richer one.
  const aa = a.is_active ? 1 : 0;
  const ab = b.is_active ? 1 : 0;
  if (ab !== aa) return ab - aa;
  return (Number(b.apy) || 0) - (Number(a.apy) || 0);
}

/**
 * The contract in force for `season`: the newest deal signed in or before
 * that season. Undefined when the player has no deal by then.
 */
export function contractForSeason(
  byName: ContractsByName,
  normalName: string,
  season: number,
): Contract | undefined {
  const list = byName.get(normalName);
  if (!list) return undefined;
  for (const c of list) {
    if ((Number(c.year_signed) || 0) <= season) return c;
  }
  return undefined;
}

/**
 * Feature values for one contract in `season`. Money is in $M (the nflverse
 * CSV stores dollars; see scripts/build-contracts-snapshot.py). A deal that
 * has run out by `season` still reports its APY — that is the last known
 * price the market put on the player — but `contractYearsRemaining` is 0.
 */
export function contractFeatures(
  c: Contract | undefined,
  season: number,
): { contractAPY: number; contractGuaranteed: number; contractAPYCapPct: number; contractYearsRemaining: number } {
  if (!c) return { contractAPY: 0, contractGuaranteed: 0, contractAPYCapPct: 0, contractYearsRemaining: 0 };
  const yearsRem = Math.max(0, (Number(c.years) || 0) - (season - (Number(c.year_signed) || season)));
  return {
    contractAPY: Math.round((Number(c.apy) || 0) / 1_000_000 * 10) / 10,
    contractGuaranteed: Math.round((Number(c.guaranteed) || 0) / 1_000_000 * 10) / 10,
    contractAPYCapPct: Math.round((Number(c.apy_cap_pct) || 0) * 100) / 100,
    contractYearsRemaining: yearsRem,
  };
}
