/**
 * Team-level projection engine.
 *
 * Base methodology: projected[k] = prior[k] * teamWeight + leagueAvg[k] * (1 - teamWeight)
 *
 * Enhanced with adjustment factors from:
 * - Vegas implied totals (market-adjusted scoring expectations)
 * - Coaching changes (new OC = regression to league avg)
 * - QB rushing tendencies (affects pass/rush split)
 * - Team pace (plays per game from PBP)
 */

import type { SeasonTotals, Game } from '../types';
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
  pprPts:   number;
}

export interface TeamProjectionContext {
  games?: Game[];           // for Vegas lines & coaching
  coachChanges?: Set<string>; // teams with new head coach
  qbRushByTeam?: Map<string, number>; // team → QB rush attempts (current QB's tendency)
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
 * team → projected TeamTotals for the CURRENT season.
 */
export function projectTeamTotals(
  priorTotals: SeasonTotals[],
  teamWeight = projectionConfig.winner.teamWeight,
  context?: TeamProjectionContext,
): Map<string, TeamTotals> {
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

  // ── Step 2.5: Vegas implied scoring adjustments ──
  const vegasMultiplier = new Map<string, number>(); // team → scoring multiplier
  if (context?.games) {
    const teamImplied = new Map<string, { total: number; games: number }>();
    for (const g of context.games) {
      if (g.game_type !== 'REG') continue;
      const tl = g.total_line || 0;
      const sl = g.spread_line || 0;
      if (tl > 0) {
        const homeImp = (tl - sl) / 2;
        const awayImp = (tl + sl) / 2;
        const ha = teamImplied.get(g.home_team) || { total: 0, games: 0 };
        ha.total += homeImp; ha.games += 1;
        teamImplied.set(g.home_team, ha);
        const aa = teamImplied.get(g.away_team) || { total: 0, games: 0 };
        aa.total += awayImp; aa.games += 1;
        teamImplied.set(g.away_team, aa);
      }
    }
    // Compute avg implied total and league avg
    let leagueImpliedSum = 0, leagueImpliedN = 0;
    for (const v of teamImplied.values()) {
      if (v.games > 0) { leagueImpliedSum += v.total / v.games; leagueImpliedN++; }
    }
    const leagueImpliedAvg = leagueImpliedN > 0 ? leagueImpliedSum / leagueImpliedN : 23;
    for (const [team, v] of teamImplied) {
      if (v.games > 0) {
        const teamAvg = v.total / v.games;
        vegasMultiplier.set(team, teamAvg / leagueImpliedAvg);
      }
    }
  }

  // ── Step 3: blend with adjustments ──
  const result = new Map<string, TeamTotals>();
  for (const [team, prior] of priorByTeam) {
    // Coach change: regress more toward league average (new coach = uncertainty)
    const isCoachChange = context?.coachChanges?.has(team) || false;
    const effectiveTeamWeight = isCoachChange ? teamWeight * 0.7 : teamWeight;
    const effectiveLeagueWeight = 1 - effectiveTeamWeight;

    const raw = zero();
    for (const k of KEYS) {
      (raw as Record<string, number>)[k] = Math.round(
        (prior as Record<string, number>)[k] * effectiveTeamWeight +
        (avg   as Record<string, number>)[k] * effectiveLeagueWeight,
      );
    }

    // Apply Vegas multiplier (market-adjusted scoring expectation)
    const vm = vegasMultiplier.get(team) || 1;
    if (vm !== 1) {
      for (const k of KEYS) {
        (raw as Record<string, number>)[k] = Math.round((raw as Record<string, number>)[k] * vm);
      }
    }

    // QB rushing adjustment: if new QB runs more, shift rush/pass split
    const qbRush = context?.qbRushByTeam?.get(team);
    if (qbRush !== undefined) {
      // Compare to prior team's QB rush attempts (from the prior data)
      const priorQBRush = priorTotals
        .filter((p) => p.position === 'QB' && p.recent_team === team)
        .reduce((max, p) => Math.max(max, p.carries || 0), 0);
      const rushDelta = qbRush - priorQBRush;
      if (Math.abs(rushDelta) > 20) {
        // Significant QB rushing change: adjust rush/pass split
        raw.rushAtt += Math.round(rushDelta * 0.6); // QB gets ~60% of the delta
        raw.passAtt -= Math.round(rushDelta * 0.3); // Some pass plays convert to runs
      }
    }

    const totalTD = raw.passTD + raw.rushTD;
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
