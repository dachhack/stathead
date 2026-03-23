/**
 * Player-level projection features derived from our team-projection methodology.
 *
 * These are used as additional predictors in the ADP Hit/Bust model and the
 * KTC Dynasty Predictive model to test whether forward-looking projections
 * improve accuracy over pure prior-season stats.
 *
 * The approach:
 *   1. Run projectTeamTotals(priorStats) → projected team-level volumes for each team.
 *   2. Scale each player's prior share into the new projected volume.
 *   3. Derive simplified projected PPR and relative-to-expected signals.
 */

import type { PlayerStats, SeasonTotals, ScenarioConfig } from '../types';
import { aggregateToSeasonTotals } from '../data';
import { projectTeamTotals } from './teamProjection';

export interface PlayerProjectionFeatures {
  projTeamPassAtt: number;          // projected team pass attempts (absolute)
  projTeamPassVolChg: number;       // % change in team pass volume vs prior (+ = more volume)
  projPlayerPPR: number;            // simplified projected PPR for this player
  projPlayerVsExpected: number;     // projPlayerPPR / (priorPPG × 17) – 1  (+ = above pace)
  projTargetShare: number;          // player's prior target share (used in projection)
}

function norm(name: string | null | undefined): string {
  if (!name) return '';
  return name.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Given prior-season raw weekly player stats (PlayerStats[]), compute projection
 * features for every player who had meaningful prior-year activity (≥4 games).
 *
 * Accepts raw weekly stats (PlayerStats[]) so callers can pass `priorStats`
 * directly without pre-aggregating. Aggregation is done internally.
 *
 * Returns a Map keyed by normalized player name → ProjectionFeatures.
 */
export function computePlayerProjectionFeatures(
  rawPriorStats: PlayerStats[],
  scenario?: ScenarioConfig,
): Map<string, PlayerProjectionFeatures> {
  const results = new Map<string, PlayerProjectionFeatures>();

  // Aggregate weekly rows to season totals (REG only)
  const regWeekly = rawPriorStats.filter((p) => p.season_type === 'REG' && p.recent_team);
  const reg: SeasonTotals[] = aggregateToSeasonTotals(regWeekly);

  // ── Prior team-level aggregates ──
  const priorTeam = new Map<string, {
    passAtt: number; targets: number; carries: number;
    recTD: number; rushTD: number;
  }>();
  for (const p of reg) {
    const t = p.recent_team!;
    const row = priorTeam.get(t) ?? { passAtt: 0, targets: 0, carries: 0, recTD: 0, rushTD: 0 };
    row.passAtt  += p.attempts        || 0;
    row.targets  += p.targets         || 0;
    row.carries  += p.carries         || 0;
    row.recTD    += p.receiving_tds   || 0;
    row.rushTD   += p.rushing_tds     || 0;
    priorTeam.set(t, row);
  }

  // ── Projected team totals (same blend as StatProjections) ──
  const projected = projectTeamTotals(reg);

  // ── Per-player features ──
  for (const p of reg) {
    const name = norm(p.player_display_name);
    if (!name) continue;

    const games = p.games || 0;
    if (games < 4) continue; // need enough sample

    const t    = p.recent_team!;
    const pt   = priorTeam.get(t);
    const proj = projected.get(t);
    if (!pt || !proj) continue;

    // Team pass volume signals
    const priorPassAtt = pt.passAtt || 1;
    const projPassAtt  = proj.passAtt || 1;

    // Target-share receiving projection
    const priorTargets     = p.targets    || 0;
    const priorTeamTargets = pt.targets   || 1;
    const tgtShare         = priorTargets / priorTeamTargets;

    const projTeamTargets  = proj.targets || projPassAtt;
    const projTgt          = projTeamTargets * tgtShare;
    const catchRate        = priorTargets > 0 ? (p.receptions || 0) / priorTargets : 0.65;
    const projRec          = projTgt * catchRate;
    const priorRec         = p.receptions || 0;
    const ypr              = priorRec > 0 ? (p.receiving_yards || 0) / priorRec : 10;
    const projRecYds       = projRec * ypr;
    const projRecTD        = (proj.recTD || 0) * tgtShare;

    // Rush-share projection
    const priorCarries     = p.carries    || 0;
    const priorTeamCarries = pt.carries   || 1;
    const rushShare        = priorCarries / priorTeamCarries;
    const projRushAtt      = (proj.rushAtt || 0) * rushShare;
    const ypc              = priorCarries > 0 ? (p.rushing_yards || 0) / priorCarries : 4;
    const projRushYds      = projRushAtt * ypc;
    const projRushTD       = (proj.rushTD || 0) * rushShare;

    // Simplified PPR (no QB passing value here — that's added via passAtt signals)
    const projPPR = projRec + projRecYds * 0.1 + projRecTD * 6
      + projRushYds * 0.1 + projRushTD * 6;

    // ── Scenario adjustments (applied to prediction-year features only) ──
    let scaledPPR     = projPPR;
    let scaledPassAtt = projPassAtt;

    if (scenario) {
      const pos = p.position;

      // TeamStatAdjustment: PassingAttempts delta → scale pass-volume for receivers/QBs
      const tsa = scenario.teamStatAdjustments.find((a) => a.team === t && a.stat === 'PassingAttempts');
      if (tsa) {
        const passFactor = 1 + tsa.delta / 100;
        scaledPassAtt *= passFactor;
        if (pos === 'WR' || pos === 'TE' || pos === 'QB') scaledPPR *= passFactor;
      }

      // TeamTendency: passRatioDelta → receivers benefit, RBs lose from more pass
      const tt = scenario.teamTendencies.find((v) => v.team === t);
      if (tt) {
        const ratio = tt.passRatioDelta / 100;
        if (pos === 'WR' || pos === 'TE' || pos === 'QB') scaledPPR *= (1 + ratio * 0.5);
        if (pos === 'RB')                                  scaledPPR *= (1 - ratio * 0.3);
      }

      // TeamVolume: overall volume scale for all players on this team
      const tv = scenario.teamVolumes.find((v) => v.team === t);
      if (tv) {
        const volFactor = 1 + tv.volumeDelta / 100;
        scaledPPR     *= volFactor;
        scaledPassAtt *= volFactor;
      }

      // VolumeOverride: individual player-level PPR scale
      const vo = scenario.volumeOverrides.find((o) => norm(o.playerName) === name);
      if (vo) scaledPPR *= (1 + vo.volumeDelta / 100);
    }

    // Relative-to-prior-pace: positive means projected outperformance
    const priorPPR         = p.fantasy_points_ppr || 0;
    const priorPPG         = games > 0 ? priorPPR / games : 0;
    const priorPPRPace     = priorPPG * 17;
    const projVsExpected   = priorPPRPace > 5 ? scaledPPR / priorPPRPace - 1 : 0;

    results.set(name, {
      projTeamPassAtt:      Math.round(scaledPassAtt),
      projTeamPassVolChg:   Math.round((scaledPassAtt / priorPassAtt - 1) * 1000) / 1000,
      projPlayerPPR:        Math.round(scaledPPR * 10) / 10,
      projPlayerVsExpected: Math.round(projVsExpected * 1000) / 1000,
      projTargetShare:      Math.round(tgtShare * 1000) / 1000,
    });
  }

  return results;
}
