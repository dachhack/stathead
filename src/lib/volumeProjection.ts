// Two-stage volume projection model:
// Stage 1: Predict team-level volumes (pass att, rush att, targets, TDs)
// Stage 2: Predict player share of team volume
// Output: enhanced projPlayerPPR feature for each player
//
// This module can be called from buildFeatureMatrix to replace the
// simple blend projection with an ML-based one.

import type { SeasonTotals, Game, PlayByPlay } from '../types';
import { trainRidgeRegression, predict } from './ridge';

export interface TeamVolumeFeatures {
  team: string;
  // Prior season volumes
  priorPassAtt: number;
  priorRushAtt: number;
  priorTargets: number;
  priorPassTD: number;
  priorRushTD: number;
  priorPPR: number;
  // Coaching
  newCoach: number;
  // Vegas
  vegasImpliedTotal: number;
  vegasWinPct: number;
  // Scheme from PBP
  passRate: number;
  neutralPassRate: number;
  pace: number; // plays per game
  shotgunRate: number;
  noHuddleRate: number;
  // QB rushing impact
  qbRushAtt: number;
  qbRushShare: number;
  // Personnel
  p11Rate: number;
  p12Rate: number;
  // O-line
  sackRate: number;
  rushYPC: number;
}

export interface PlayerShareFeatures {
  name: string;
  team: string;
  position: string;
  // Prior share
  priorTargetShare: number;
  priorRushShare: number;
  priorSnapPct: number;
  // Competition
  depthChartRank: number;
  teamSamePosCount: number;
  newArrivals: number;
  // Contract/investment
  contractAPY: number;
  draftCapital: number;
  // Player quality
  priorPPG: number;
  age: number;
  yearsInLeague: number;
  // Team context
  teamPassRate: number;
}

interface TeamVolumeRow extends TeamVolumeFeatures {
  // Targets (actuals)
  actualPassAtt: number;
  actualRushAtt: number;
  actualTargets: number;
  actualPassTD: number;
  actualRushTD: number;
}

export interface VolumeProjectionResult {
  teamVolumes: Map<string, {
    projPassAtt: number; projRushAtt: number; projTargets: number;
    projPassTD: number; projRushTD: number;
  }>;
}

/**
 * Build training data for the team volume model from historical seasons.
 */
export function buildTeamVolumeTrainingData(
  seasons: number[],
  seasonData: Map<number, {
    priorTotals: SeasonTotals[];
    currentTotals: SeasonTotals[];
    games: Game[];
    pbp: PlayByPlay[];
    coachChanges: Set<string>;
    qbRushByTeam: Map<string, number>;
    vegasByTeam: Map<string, { impliedTotal: number; winPct: number }>;
    schemeByTeam: Map<string, { passRate: number; neutralPassRate: number; pace: number; shotgunRate: number; noHuddleRate: number; sackRate: number; rushYPC: number }>;
    personnelByTeam: Map<string, { p11Rate: number; p12Rate: number }>;
  }>,
): TeamVolumeRow[] {
  const rows: TeamVolumeRow[] = [];

  for (const season of seasons) {
    const data = seasonData.get(season);
    if (!data) continue;

    // Prior team totals
    const priorByTeam = new Map<string, { passAtt: number; rushAtt: number; targets: number; passTD: number; rushTD: number; ppr: number }>();
    for (const p of data.priorTotals) {
      const team = p.recent_team || '';
      if (!team) continue;
      const t = priorByTeam.get(team) || { passAtt: 0, rushAtt: 0, targets: 0, passTD: 0, rushTD: 0, ppr: 0 };
      t.passAtt += p.attempts || 0;
      t.rushAtt += p.carries || 0;
      t.targets += p.targets || 0;
      t.passTD += p.passing_tds || 0;
      t.rushTD += p.rushing_tds || 0;
      t.ppr += p.fantasy_points_ppr || 0;
      priorByTeam.set(team, t);
    }

    // Actual current-season team totals
    const actualByTeam = new Map<string, { passAtt: number; rushAtt: number; targets: number; passTD: number; rushTD: number }>();
    for (const p of data.currentTotals) {
      const team = p.recent_team || '';
      if (!team) continue;
      const t = actualByTeam.get(team) || { passAtt: 0, rushAtt: 0, targets: 0, passTD: 0, rushTD: 0 };
      t.passAtt += p.attempts || 0;
      t.rushAtt += p.carries || 0;
      t.targets += p.targets || 0;
      t.passTD += p.passing_tds || 0;
      t.rushTD += p.rushing_tds || 0;
      actualByTeam.set(team, t);
    }

    for (const [team, actual] of actualByTeam) {
      const prior = priorByTeam.get(team);
      if (!prior) continue;

      const vegas = data.vegasByTeam.get(team);
      const scheme = data.schemeByTeam.get(team);
      const personnel = data.personnelByTeam.get(team);
      const qbRush = data.qbRushByTeam.get(team) || 0;

      rows.push({
        team,
        priorPassAtt: prior.passAtt,
        priorRushAtt: prior.rushAtt,
        priorTargets: prior.targets,
        priorPassTD: prior.passTD,
        priorRushTD: prior.rushTD,
        priorPPR: prior.ppr,
        newCoach: data.coachChanges.has(team) ? 1 : 0,
        vegasImpliedTotal: vegas?.impliedTotal || 0,
        vegasWinPct: vegas?.winPct || 0,
        passRate: scheme?.passRate || 0.5,
        neutralPassRate: scheme?.neutralPassRate || 0.5,
        pace: scheme?.pace || 64,
        shotgunRate: scheme?.shotgunRate || 0.5,
        noHuddleRate: scheme?.noHuddleRate || 0,
        qbRushAtt: qbRush,
        qbRushShare: prior.rushAtt > 0 ? qbRush / prior.rushAtt : 0,
        p11Rate: personnel?.p11Rate || 0,
        p12Rate: personnel?.p12Rate || 0,
        sackRate: scheme?.sackRate || 0.06,
        rushYPC: scheme?.rushYPC || 4.0,
        actualPassAtt: actual.passAtt,
        actualRushAtt: actual.rushAtt,
        actualTargets: actual.targets,
        actualPassTD: actual.passTD,
        actualRushTD: actual.rushTD,
      });
    }
  }

  return rows;
}

/**
 * Train the team volume model and return predictions for a target season.
 */
export function trainTeamVolumeModel(
  trainingRows: TeamVolumeRow[],
  predictionFeatures: TeamVolumeFeatures[],
): Map<string, { projPassAtt: number; projRushAtt: number; projTargets: number; projPassTD: number; projRushTD: number }> {
  const featureKeys: (keyof TeamVolumeFeatures)[] = [
    'priorPassAtt', 'priorRushAtt', 'priorTargets', 'priorPassTD', 'priorRushTD', 'priorPPR',
    'newCoach', 'vegasImpliedTotal', 'vegasWinPct',
    'passRate', 'neutralPassRate', 'pace', 'shotgunRate', 'noHuddleRate',
    'qbRushAtt', 'qbRushShare',
    'p11Rate', 'p12Rate', 'sackRate', 'rushYPC',
  ];

  const results = new Map<string, { projPassAtt: number; projRushAtt: number; projTargets: number; projPassTD: number; projRushTD: number }>();

  const targets: { key: string; actual: keyof TeamVolumeRow }[] = [
    { key: 'projPassAtt', actual: 'actualPassAtt' },
    { key: 'projRushAtt', actual: 'actualRushAtt' },
    { key: 'projTargets', actual: 'actualTargets' },
    { key: 'projPassTD', actual: 'actualPassTD' },
    { key: 'projRushTD', actual: 'actualRushTD' },
  ];

  // Initialize results for each prediction team
  for (const pf of predictionFeatures) {
    results.set(pf.team, { projPassAtt: 0, projRushAtt: 0, projTargets: 0, projPassTD: 0, projRushTD: 0 });
  }

  for (const { key, actual } of targets) {
    const X = trainingRows.map((r) => featureKeys.map((k) => (r as unknown as Record<string, number>)[k] || 0));
    const y = trainingRows.map((r) => (r as unknown as Record<string, number>)[actual] || 0);

    if (X.length < 30) continue;

    // Use Ridge for team-level (small N per season, ~32 teams)
    const model = trainRidgeRegression(X, y, featureKeys as string[], 10);

    for (const pf of predictionFeatures) {
      const features: Record<string, number> = {};
      for (const k of featureKeys) features[k as string] = (pf as unknown as Record<string, number>)[k] || 0;
      const pred = predict(model, features);
      const r = results.get(pf.team)!;
      (r as unknown as Record<string, number>)[key] = Math.round(pred.predicted);
    }
  }

  return results;
}
