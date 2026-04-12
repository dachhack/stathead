// Two-stage volume projection model:
// Stage 1: Predict team-level volumes (pass att, rush att, targets, TDs)
// Stage 2: Predict player share of team volume
// Output: enhanced projPlayerPPR feature for each player
//
// This module can be called from buildFeatureMatrix to replace the
// simple blend projection with an ML-based one.

import type { SeasonTotals, Game } from '../types';
import { trainRidgeRegression, predict } from './ridge';
import { trainGBM, predictGBM } from './gbm';

export interface TeamVolumeFeatures {
  team: string;
  season: number;
  // Prior season volumes
  priorPassAtt: number;
  priorRushAtt: number;
  priorTargets: number;
  priorPassTD: number;
  priorRushTD: number;
  priorTotalPlays: number;
  priorPPR: number;
  // 2-year volume trends
  passAttTrend: number;   // change from 2 years ago to 1 year ago
  rushAttTrend: number;
  targetsTrend: number;
  // Coaching
  newCoach: number;
  // Vegas
  vegasImpliedTotal: number;
  vegasWinPct: number;
  vegasSpread: number;
  // Scheme from PBP
  passRate: number;
  neutralPassRate: number;
  pace: number;
  shotgunRate: number;
  noHuddleRate: number;
  firstDownRunRate: number;
  // QB impact
  qbOwnRushAtt: number;
  qbOwnScrambleRate: number;
  teamPriorQBRushAtt: number;
  // QB quality
  qbPPG: number;
  // Personnel
  p11Rate: number;
  p12Rate: number;
  // O-line quality
  sackRate: number;
  rushYPC: number;
  // Roster investment
  offensiveDraftCapital: number; // sum of (8 - round) for offensive draft picks
  rosterTurnover: number;
  // RB/TE target rates
  rbTargetRate: number;
  teTargetRate: number;
}

interface TeamVolumeRow extends TeamVolumeFeatures {
  actualPassAtt: number;
  actualRushAtt: number;
  actualTargets: number;
  actualPassTD: number;
  actualRushTD: number;
  actualTotalPlays: number;
}

const VOLUME_FEATURE_KEYS: (keyof Omit<TeamVolumeFeatures, 'team' | 'season'>)[] = [
  'priorPassAtt', 'priorRushAtt', 'priorTargets', 'priorPassTD', 'priorRushTD',
  'priorTotalPlays', 'priorPPR',
  'passAttTrend', 'rushAttTrend', 'targetsTrend',
  'newCoach',
  'vegasImpliedTotal', 'vegasWinPct', 'vegasSpread',
  'passRate', 'neutralPassRate', 'pace', 'shotgunRate', 'noHuddleRate', 'firstDownRunRate',
  'qbOwnRushAtt', 'qbOwnScrambleRate', 'teamPriorQBRushAtt',
  'qbPPG',
  'p11Rate', 'p12Rate',
  'sackRate', 'rushYPC',
  'offensiveDraftCapital', 'rosterTurnover',
  'rbTargetRate', 'teTargetRate',
];

export interface TeamVolumePrediction {
  projPassAtt: number;
  projRushAtt: number;
  projTargets: number;
  projPassTD: number;
  projRushTD: number;
  projTotalPlays: number;
}

export interface TrainedTeamVolumeModel {
  models: Record<string, unknown>; // target → trained model
  featureKeys: string[];
  cvMetrics: Record<string, { r2: number; mae: number }>;
}

/**
 * Build team volume training data from aggregated season totals.
 */
export function buildTeamVolumeData(
  seasons: number[],
  allTotals: Map<number, SeasonTotals[]>, // season → totals
  gamesData: Game[],
  coachChanges: Map<number, Set<string>>, // season → teams with new coach
  qbStats: Map<string, { rushAtt: number; scrambleRate: number; ppg: number }>, // "season:team" → QB stats
  teamPriorQBRush: Map<string, number>, // "season:team" → prior team QB rush att
  schemeData: Map<string, { passRate: number; neutralPassRate: number; pace: number; shotgunRate: number; noHuddleRate: number; firstDownRunRate: number; sackRate: number; rushYPC: number; rbTargetRate: number; teTargetRate: number }>,
  personnelData: Map<string, { p11Rate: number; p12Rate: number }>,
  draftCapital: Map<string, number>, // "season:team" → offensive draft capital
  rosterTurnover: Map<string, number>, // "season:team" → turnover rate
): TeamVolumeRow[] {
  const rows: TeamVolumeRow[] = [];

  for (const season of seasons) {
    const currentTotals = allTotals.get(season);
    const priorTotals = allTotals.get(season - 1);
    const prior2Totals = allTotals.get(season - 2);
    if (!currentTotals || !priorTotals) continue;

    // Aggregate to team level
    const aggTeam = (totals: SeasonTotals[]) => {
      const m = new Map<string, { passAtt: number; rushAtt: number; targets: number; passTD: number; rushTD: number; plays: number; ppr: number }>();
      for (const p of totals) {
        const team = p.recent_team || '';
        if (!team) continue;
        const t = m.get(team) || { passAtt: 0, rushAtt: 0, targets: 0, passTD: 0, rushTD: 0, plays: 0, ppr: 0 };
        t.passAtt += p.attempts || 0;
        t.rushAtt += p.carries || 0;
        t.targets += p.targets || 0;
        t.passTD += p.passing_tds || 0;
        t.rushTD += p.rushing_tds || 0;
        t.plays += (p.attempts || 0) + (p.carries || 0);
        t.ppr += p.fantasy_points_ppr || 0;
        m.set(team, t);
      }
      return m;
    };

    const current = aggTeam(currentTotals);
    const prior = aggTeam(priorTotals);
    const prior2 = prior2Totals ? aggTeam(prior2Totals) : null;

    // Vegas data for this season
    const vegasByTeam = new Map<string, { impliedTotal: number; winPct: number; spread: number }>();
    for (const g of gamesData) {
      if (g.game_type !== 'REG' || g.season !== season - 1) continue;
      const tl = g.total_line || 0;
      const sl = g.spread_line || 0;
      if (tl <= 0) continue;
      for (const [team, implied] of [[g.home_team, (tl - sl) / 2], [g.away_team, (tl + sl) / 2]] as [string, number][]) {
        const v = vegasByTeam.get(team) || { impliedTotal: 0, winPct: 0, spread: 0 };
        v.impliedTotal += implied;
        v.spread += team === g.home_team ? sl : -sl;
        if ((team === g.home_team && (g.home_score || 0) > (g.away_score || 0)) ||
            (team === g.away_team && (g.away_score || 0) > (g.home_score || 0))) {
          v.winPct += 1;
        }
        vegasByTeam.set(team, v);
      }
    }
    // Normalize to per-game
    for (const [team, v] of vegasByTeam) {
      const games = gamesData.filter((g) => g.game_type === 'REG' && g.season === season - 1 && (g.home_team === team || g.away_team === team)).length || 1;
      v.impliedTotal /= games;
      v.winPct /= games;
      v.spread /= games;
    }

    for (const [team, act] of current) {
      const pr = prior.get(team);
      if (!pr) continue;

      const pr2 = prior2?.get(team);
      const vegas = vegasByTeam.get(team);
      const cc = coachChanges.get(season);
      const qb = qbStats.get(`${season}:${team}`);
      const tpqr = teamPriorQBRush.get(`${season}:${team}`) || 0;
      const scheme = schemeData.get(`${season - 1}:${team}`);
      const pers = personnelData.get(`${season - 1}:${team}`);
      const dc = draftCapital.get(`${season}:${team}`) || 0;
      const rt = rosterTurnover.get(`${season}:${team}`) || 0;

      rows.push({
        team, season,
        priorPassAtt: pr.passAtt, priorRushAtt: pr.rushAtt, priorTargets: pr.targets,
        priorPassTD: pr.passTD, priorRushTD: pr.rushTD,
        priorTotalPlays: pr.plays, priorPPR: pr.ppr,
        passAttTrend: pr2 ? pr.passAtt - pr2.passAtt : 0,
        rushAttTrend: pr2 ? pr.rushAtt - pr2.rushAtt : 0,
        targetsTrend: pr2 ? pr.targets - pr2.targets : 0,
        newCoach: cc?.has(team) ? 1 : 0,
        vegasImpliedTotal: vegas?.impliedTotal || 0,
        vegasWinPct: vegas?.winPct || 0,
        vegasSpread: vegas?.spread || 0,
        passRate: scheme?.passRate || 0.55,
        neutralPassRate: scheme?.neutralPassRate || 0.55,
        pace: scheme?.pace || 64,
        shotgunRate: scheme?.shotgunRate || 0.55,
        noHuddleRate: scheme?.noHuddleRate || 0.1,
        firstDownRunRate: scheme?.firstDownRunRate || 0.45,
        qbOwnRushAtt: qb?.rushAtt || 0,
        qbOwnScrambleRate: qb?.scrambleRate || 0,
        teamPriorQBRushAtt: tpqr,
        qbPPG: qb?.ppg || 0,
        p11Rate: pers?.p11Rate || 0,
        p12Rate: pers?.p12Rate || 0,
        sackRate: scheme?.sackRate || 0.06,
        rushYPC: scheme?.rushYPC || 4.0,
        offensiveDraftCapital: dc,
        rosterTurnover: rt,
        rbTargetRate: scheme?.rbTargetRate || 0.15,
        teTargetRate: scheme?.teTargetRate || 0.2,
        actualPassAtt: act.passAtt, actualRushAtt: act.rushAtt,
        actualTargets: act.targets, actualPassTD: act.passTD,
        actualRushTD: act.rushTD, actualTotalPlays: act.plays,
      });
    }
  }
  return rows;
}

/**
 * Train team volume models and return predictions.
 * Uses GBM with LOSO CV for honest evaluation.
 */
export function trainTeamVolumeModel(
  trainingRows: TeamVolumeRow[],
  predictionFeatures: TeamVolumeFeatures[],
): { predictions: Map<string, TeamVolumePrediction>; model: TrainedTeamVolumeModel } {
  const featureKeys = VOLUME_FEATURE_KEYS as string[];

  const predictions = new Map<string, TeamVolumePrediction>();
  for (const pf of predictionFeatures) {
    predictions.set(pf.team, { projPassAtt: 0, projRushAtt: 0, projTargets: 0, projPassTD: 0, projRushTD: 0, projTotalPlays: 0 });
  }

  const targets: { key: keyof TeamVolumePrediction; actual: keyof TeamVolumeRow }[] = [
    { key: 'projPassAtt', actual: 'actualPassAtt' },
    { key: 'projRushAtt', actual: 'actualRushAtt' },
    { key: 'projTargets', actual: 'actualTargets' },
    { key: 'projPassTD', actual: 'actualPassTD' },
    { key: 'projRushTD', actual: 'actualRushTD' },
    { key: 'projTotalPlays', actual: 'actualTotalPlays' },
  ];

  const trainedModels: Record<string, unknown> = {};
  const cvMetrics: Record<string, { r2: number; mae: number }> = {};

  for (const { key, actual } of targets) {
    const X = trainingRows.map((r) => featureKeys.map((k) => (r as unknown as Record<string, number>)[k] || 0));
    const y = trainingRows.map((r) => (r as unknown as Record<string, number>)[actual] || 0);
    if (X.length < 30) continue;

    // Use GBM for team volumes (more expressive than Ridge for 32 features × 256 rows)
    const model = trainGBM(X, y, featureKeys, {
      nEstimators: 80, learningRate: 0.05, maxDepth: 2,
      subsample: 0.8, minSamplesLeaf: 8,
    });
    trainedModels[key] = model;

    // Also train Ridge as ensemble partner
    const ridgeModel = trainRidgeRegression(X, y, featureKeys, 10);

    // LOSO CV
    const uniqueSeasons = [...new Set(trainingRows.map((r) => r.season))].sort();
    const actuals: number[] = [];
    const preds: number[] = [];
    if (uniqueSeasons.length >= 3) {
      for (const held of uniqueSeasons) {
        const trainR = trainingRows.filter((r) => r.season !== held);
        const testR = trainingRows.filter((r) => r.season === held);
        if (trainR.length < 30) continue;
        const Xtr = trainR.map((r) => featureKeys.map((k) => (r as unknown as Record<string, number>)[k] || 0));
        const ytr = trainR.map((r) => (r as unknown as Record<string, number>)[actual] || 0);
        const foldGbm = trainGBM(Xtr, ytr, featureKeys, {
          nEstimators: 60, learningRate: 0.06, maxDepth: 2, subsample: 0.8, minSamplesLeaf: 8,
        });
        for (const row of testR) {
          actuals.push((row as unknown as Record<string, number>)[actual] || 0);
          preds.push(predictGBM(foldGbm, row as unknown as Record<string, number>).predicted);
        }
      }
    }

    if (actuals.length >= 10) {
      const mean = actuals.reduce((a, b) => a + b, 0) / actuals.length;
      const ssTot = actuals.reduce((s, v) => s + (v - mean) ** 2, 0);
      const ssRes = actuals.reduce((s, v, i) => s + (v - preds[i]) ** 2, 0);
      const r2 = ssTot > 0 ? Math.round((1 - ssRes / ssTot) * 1000) / 1000 : 0;
      const mae = Math.round(actuals.reduce((s, v, i) => s + Math.abs(v - preds[i]), 0) / actuals.length);
      cvMetrics[key] = { r2, mae };
    }

    // Generate predictions (ensemble GBM + Ridge)
    for (const pf of predictionFeatures) {
      const features = pf as unknown as Record<string, number>;
      const gbmPred = predictGBM(model, features).predicted;
      const ridgePred = predict(ridgeModel, features).predicted;
      const ensemble = Math.round(gbmPred * 0.6 + ridgePred * 0.4);
      const result = predictions.get(pf.team)!;
      (result as unknown as Record<string, number>)[key] = ensemble;
    }
  }

  return { predictions, model: { models: trainedModels, featureKeys, cvMetrics } };
}

// ═══════════════════════════════════════════════════════════════════
// Stage 2: Player Share Model
// ═══════════════════════════════════════════════════════════════════

const SHARE_FEATURE_KEYS = [
  'priorTargetShare', 'priorRushShare', 'priorSnapPct',
  'depthChartRank', 'teamSamePosCount', 'contractAPY',
  'age', 'yearsInLeague', 'priorPPG', 'isRookie',
];

export function trainPlayerShareModel(
  trainingRows: Array<Record<string, number>>,
  predictionFeatures: Array<Record<string, number>>,
  targetKey: string,
): number[] {
  if (trainingRows.length < 20) {
    return predictionFeatures.map(() => 0);
  }

  const X = trainingRows.map((r) => SHARE_FEATURE_KEYS.map((k) => r[k] || 0));
  const y = trainingRows.map((r) => r[targetKey] || 0);
  const model = trainRidgeRegression(X, y, SHARE_FEATURE_KEYS, 5);

  return predictionFeatures.map((pf) => {
    const pred = predict(model, pf);
    return Math.max(0, Math.min(1, Math.round(pred.predicted * 1000) / 1000));
  });
}

// ═══════════════════════════════════════════════════════════════════
// Stage 3: Player PPG from team volumes × player shares
// ═══════════════════════════════════════════════════════════════════

export function projectPlayerPPG(
  teamVolumes: TeamVolumePrediction,
  playerShare: { projTargetShare: number; projRushShare: number },
  position: string,
  priorEfficiency: { catchRate: number; ypr: number; ypc: number },
): number {
  const tv = teamVolumes;
  let ppg = 0;

  if (position === 'QB') {
    const passYdsPerAtt = 7.0;
    const ppgPass = tv.projPassAtt * passYdsPerAtt * 0.04 / 17 + tv.projPassTD * 4 / 17;
    const rushAtt = tv.projRushAtt * playerShare.projRushShare;
    const ppgRush = rushAtt * priorEfficiency.ypc * 0.1 / 17;
    ppg = ppgPass + ppgRush;
  } else {
    const projTargets = tv.projTargets * playerShare.projTargetShare;
    const projRec = projTargets * priorEfficiency.catchRate;
    const projRecYds = projRec * priorEfficiency.ypr;
    const projRecTD = tv.projPassTD * playerShare.projTargetShare * 0.3;
    const projRushAtt = tv.projRushAtt * playerShare.projRushShare;
    const projRushYds = projRushAtt * priorEfficiency.ypc;
    const projRushTD = tv.projRushTD * playerShare.projRushShare;
    const seasonPPR = projRec + projRecYds * 0.1 + projRecTD * 6
      + projRushYds * 0.1 + projRushTD * 6;
    ppg = seasonPPR / 17;
  }

  return Math.round(ppg * 10) / 10;
}
