/**
 * Team-level projection engine.
 *
 * Mirrors the methodology used in StatProjections for 2026:
 *   projected[k] = prior[k] * teamWeight + leagueAvg[k] * (1 - teamWeight)
 *
 * This lets us run the same model retroactively for any historical season
 * by supplying the prior year's aggregated player stats.
 */

import type { SeasonTotals } from '../types';
import projectionConfig from '../generated/projection-config.json';

export interface TeamTotals {
  passAtt:  number;
  passYds:  number;
  passTD:   number;
  rushAtt:  number;
  rushYds:  number;
  rushTD:   number;
  recYds:   number;
  recTD:    number;
  targets:  number;
  receptions: number;
  totalTD:  number;
  pprPts:   number; // approximate from projected component stats
}

const KEYS: (keyof Omit<TeamTotals, 'totalTD' | 'pprPts'>)[] = [
  'passAtt', 'passYds', 'passTD',
  'rushAtt', 'rushYds', 'rushTD',
  'recYds',  'recTD',
  'targets', 'receptions',
];

function zero(): Omit<TeamTotals, 'totalTD' | 'pprPts'> {
  return {
    passAtt: 0, passYds: 0, passTD: 0,
    rushAtt: 0, rushYds: 0, rushTD: 0,
    recYds: 0,  recTD: 0,
    targets: 0, receptions: 0,
  };
}

/**
 * Given the aggregated player stats for the PRIOR season, return a map of
 * team → projected TeamTotals for the CURRENT season, using the same
 * team/league blend weights as the live 2026 projection.
 */
export function projectTeamTotals(
  priorTotals: SeasonTotals[],
  teamWeight = projectionConfig.winner.teamWeight,
): Map<string, TeamTotals> {
  const leagueWeight = 1 - teamWeight;

  // ── Step 1: prior-season team totals ──
  const priorByTeam = new Map<string, ReturnType<typeof zero>>();
  for (const p of priorTotals) {
    const team = p.recent_team;
    if (!team) continue;
    if (!priorByTeam.has(team)) priorByTeam.set(team, zero());
    const t = priorByTeam.get(team)!;
    t.passAtt    += p.attempts          || 0;
    t.passYds    += p.passing_yards     || 0;
    t.passTD     += p.passing_tds       || 0;
    t.rushAtt    += p.carries           || 0;
    t.rushYds    += p.rushing_yards     || 0;
    t.rushTD     += p.rushing_tds       || 0;
    t.recYds     += p.receiving_yards   || 0;
    t.recTD      += p.receiving_tds     || 0;
    t.targets    += p.targets           || 0;
    t.receptions += p.receptions        || 0;
  }

  // ── Step 2: league averages ──
  const n = priorByTeam.size || 1;
  const avg = zero();
  for (const t of priorByTeam.values()) {
    for (const k of KEYS) (avg as Record<string, number>)[k] += (t as Record<string, number>)[k];
  }
  for (const k of KEYS) (avg as Record<string, number>)[k] /= n;

  // ── Step 3: blend ──
  const result = new Map<string, TeamTotals>();
  for (const [team, prior] of priorByTeam) {
    const raw = zero();
    for (const k of KEYS) {
      (raw as Record<string, number>)[k] = Math.round(
        (prior as Record<string, number>)[k] * teamWeight +
        (avg   as Record<string, number>)[k] * leagueWeight,
      );
    }
    const totalTD = raw.passTD + raw.rushTD;
    // Approximate team PPR: QB pass + team rush + all receiving
    // receptions ≈ raw.receptions (from receivers); for teams missing that, estimate from completions
    const recs = raw.receptions > 0 ? raw.receptions : Math.round(raw.passAtt * 0.635);
    const pprPts = Math.round(
      raw.passYds * 0.04 + raw.passTD * 4 +
      raw.rushYds * 0.1  + raw.rushTD * 6 +
      recs * 1 + raw.recYds * 0.1 + raw.recTD * 6,
    );
    result.set(team, { ...raw, totalTD, pprPts });
  }

  return result;
}
