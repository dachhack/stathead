/**
 * Rookie career model: trains per-position models to predict best 2-of-3 PPG
 * in a rookie's first 3 NFL years using only pre-draft features.
 * Used by both the build-time precompute script and the runtime ModelDocumentation.
 */

import { trainRidgeRegression, predict } from './ridge';
import { trainBaggedGBM, predictBaggedGBM } from './gbm';
import type { BaggedGBM } from './gbm';
import { PRE_DRAFT_ROOKIE_FEATURES, cvR2, cvMae } from './featureTypes';
import type { PlayerRow } from './featureTypes';

// Standard normal CDF approximation (Abramowitz & Stegun 26.2.17)
export function normalCdf(x: number): number {
  if (x < -8) return 0;
  if (x > 8) return 1;
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + p * Math.abs(x));
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);
  return 0.5 * (1 + sign * y);
}

// Position-specific PPG thresholds and prediction tiers
export const PPG_THRESHOLD_CONFIG: Record<string, {
  thresholds: number[];
  tiers: Array<{ label: string; min: number; max: number }>;
}> = {
  QB: {
    thresholds: [14, 16, 18, 20, 22, 24],
    tiers: [
      { label: 'Tier 1', min: 20, max: Infinity },
      { label: 'Tier 2', min: 17, max: 20 },
      { label: 'Tier 3', min: 15, max: 17 },
      { label: 'Tier 4', min: 13, max: 15 },
      { label: 'Tier 5', min: 11, max: 13 },
      { label: 'Tier 6', min: 8, max: 11 },
      { label: 'Tier 7', min: 0, max: 8 },
    ],
  },
  RB: {
    thresholds: [10, 12, 14, 16, 18, 20],
    tiers: [
      { label: 'Tier 1', min: 16, max: Infinity },
      { label: 'Tier 2', min: 13, max: 16 },
      { label: 'Tier 3', min: 10, max: 13 },
      { label: 'Tier 4', min: 8, max: 10 },
      { label: 'Tier 5', min: 6, max: 8 },
      { label: 'Tier 6', min: 4, max: 6 },
      { label: 'Tier 7', min: 0, max: 4 },
    ],
  },
  WR: {
    thresholds: [10, 12, 14, 16, 18, 20],
    tiers: [
      { label: 'Tier 1', min: 16, max: Infinity },
      { label: 'Tier 2', min: 13, max: 16 },
      { label: 'Tier 3', min: 10, max: 13 },
      { label: 'Tier 4', min: 8, max: 10 },
      { label: 'Tier 5', min: 6, max: 8 },
      { label: 'Tier 6', min: 4, max: 6 },
      { label: 'Tier 7', min: 0, max: 4 },
    ],
  },
  TE: {
    thresholds: [7, 8, 9, 10, 11, 12],
    tiers: [
      { label: 'Tier 1', min: 12, max: Infinity },
      { label: 'Tier 2', min: 10, max: 12 },
      { label: 'Tier 3', min: 8, max: 10 },
      { label: 'Tier 4', min: 6, max: 8 },
      { label: 'Tier 5', min: 5, max: 6 },
      { label: 'Tier 6', min: 3, max: 5 },
      { label: 'Tier 7', min: 0, max: 3 },
    ],
  },
};

export interface RookieCareerBacktestRow {
  name: string;
  position: string;
  draftSeason: number;
  actualPPG: number;        // best 2-of-3 actual
  predictedPPG: number;     // LOSO prediction
  combinedScore: number;
  percentile: number;
  modelTier: number;
  thresholdProbs: Record<number, number>;
}

export interface RookieCareerModelResult {
  n: number;
  cvR2: number;
  cvMAE: number;
  rankCorr: number;
  topN: Record<number, { precision: number; recall: number; n: number }>;
  seasons: number;
  featureKeys: string[];
  featureImportance: Array<{ key: string; importance: number }>;
  residualStd: number;
  thresholds: number[];
  thresholdTable: {
    thresholds: number[];
    tiers: Array<{ label: string; min: number; max: number; n: number; hitRates: number[] }>;
  };
  backtestRows: RookieCareerBacktestRow[];
  ridgeModel?: unknown;
  gbmModel?: BaggedGBM | null;
}

function rankArray(arr: number[]): number[] {
  const indexed = arr.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array(arr.length);
  for (let k = 0; k < indexed.length; k++) ranks[indexed[k].i] = k + 1;
  return ranks;
}

function spearman(ranks1: number[], ranks2: number[]): number {
  const n = ranks1.length;
  if (n < 3) return 0;
  const mean1 = ranks1.reduce((a, b) => a + b, 0) / n;
  const mean2 = ranks2.reduce((a, b) => a + b, 0) / n;
  let cov = 0, var1 = 0, var2 = 0;
  for (let i = 0; i < n; i++) {
    const d1 = ranks1[i] - mean1, d2 = ranks2[i] - mean2;
    cov += d1 * d2; var1 += d1 * d1; var2 += d2 * d2;
  }
  return var1 > 0 && var2 > 0 ? cov / Math.sqrt(var1 * var2) : 0;
}

/**
 * Train rookie career prediction models from player rows.
 * Returns per-position model results with evaluation metrics and threshold tables.
 */
export function trainRookieCareerModels(
  rows: PlayerRow[],
): Record<string, RookieCareerModelResult> {
  const TOP_N_THRESHOLDS = [12, 24, 36, 48, 60];

  // Step 1: Build games lookup from priorGames
  const careerGamesMap = new Map<string, number>();
  for (const row of rows) {
    const priorSeason = row.season - 1;
    const key = `${row.name}::${row.position}::${priorSeason}`;
    if (row.features.priorGames > 0) {
      careerGamesMap.set(key, row.features.priorGames);
    }
  }

  // Step 2: Group rows by player, build career PPG map
  const careerMap = new Map<string, {
    name: string; position: string; draftSeason: number;
    features: Record<string, number>;
    seasonPPGs: { season: number; ppg: number; games: number }[];
  }>();

  for (const row of rows) {
    const key = `${row.name}::${row.position}`;
    if (!careerMap.has(key)) {
      careerMap.set(key, {
        name: row.name, position: row.position,
        draftSeason: 0, features: {},
        seasonPPGs: [],
      });
    }
    const entry = careerMap.get(key)!;
    const gamesKey = `${row.name}::${row.position}::${row.season}`;
    const games = careerGamesMap.get(gamesKey) || (row.rawPPG > 0 ? 17 : 0);
    entry.seasonPPGs.push({ season: row.season, ppg: row.rawPPG, games });
    const yil = row.features.yearsInLeague ?? 99;
    if (yil <= 1 && (entry.draftSeason === 0 || row.season < entry.draftSeason)) {
      entry.draftSeason = row.season;
      entry.features = { ...row.features };
    }
  }

  // Step 3: Compute best-2-of-3 target
  interface CareerRow {
    name: string; position: string; draftSeason: number;
    best2of3PPG: number; features: Record<string, number>;
  }
  const careerRows: CareerRow[] = [];

  for (const [, entry] of careerMap) {
    if (entry.draftSeason === 0) continue;
    const first3 = entry.seasonPPGs
      .filter(s => s.season >= entry.draftSeason && s.season < entry.draftSeason + 3)
      .sort((a, b) => b.ppg - a.ppg);
    if (first3.length < 2) continue;
    const qualifying = first3.filter(s => s.games >= 4);
    if (qualifying.length < 2) continue;
    const best2 = qualifying.slice(0, 2);
    const best2of3PPG = Math.round((best2[0].ppg + best2[1].ppg) / 2 * 100) / 100;
    const yil = entry.features.yearsInLeague ?? 99;
    if (yil > 1) continue;
    careerRows.push({ name: entry.name, position: entry.position, draftSeason: entry.draftSeason, best2of3PPG, features: entry.features });
  }

  // Step 4: Per-position training with LOSO CV
  const results: Record<string, RookieCareerModelResult> = {};

  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    const posRows = careerRows.filter(r => r.position === pos);
    if (posRows.length < 10) continue;
    const featureKeys = PRE_DRAFT_ROOKIE_FEATURES[pos] || [];
    if (featureKeys.length === 0) continue;

    const seasons = [...new Set(posRows.map(r => r.draftSeason))].sort();
    const losoActuals: number[] = [];
    const losoPreds: number[] = [];
    const losoSeasons: number[] = [];
    const losoNames: string[] = [];

    for (const held of seasons) {
      const trainR = posRows.filter(r => r.draftSeason !== held);
      const testR = posRows.filter(r => r.draftSeason === held);
      if (trainR.length < 10 || testR.length === 0) continue;

      const Xtr = trainR.map(r => featureKeys.map(k => r.features[k] || 0));
      const ytr = trainR.map(r => r.best2of3PPG);
      const Xte = testR.map(r => featureKeys.map(k => r.features[k] || 0));

      const ridgeModel = trainRidgeRegression(Xtr, ytr, featureKeys, 5);
      let preds: number[];

      if (trainR.length >= 40) {
        const gbmModel = trainBaggedGBM(Xtr, ytr, featureKeys, {
          nEstimators: 60, learningRate: 0.04, maxDepth: 2,
          subsample: 0.8, minSamplesLeaf: Math.max(3, Math.round(trainR.length * 0.08)),
          seed: 42,
        }, 5);
        preds = Xte.map((x) => {
          // Build clean feature dict for predictions (only use featureKeys, default to 0)
          const feat: Record<string, number> = {};
          featureKeys.forEach((k, j) => { feat[k] = isFinite(x[j]) ? x[j] : 0; });
          const gbmP = predictBaggedGBM(gbmModel, feat).predicted;
          const ridgeP = predict(ridgeModel, feat).predicted;
          const p = gbmP * 0.5 + ridgeP * 0.5;
          return isFinite(p) ? p : 0;
        });
      } else {
        preds = testR.map(r => {
          const feat: Record<string, number> = {};
          featureKeys.forEach(k => { feat[k] = isFinite(r.features[k]) ? r.features[k] : 0; });
          const p = predict(ridgeModel, feat).predicted;
          return isFinite(p) ? p : 0;
        });
      }

      for (let i = 0; i < testR.length; i++) {
        losoActuals.push(testR[i].best2of3PPG);
        losoPreds.push(Math.max(0, preds[i]));
        losoSeasons.push(held);
        losoNames.push(testR[i].name);
      }
    }

    // Filter out any NaN predictions before computing metrics
    const validIdx = losoPreds.map((p, i) => ({ p, a: losoActuals[i], s: losoSeasons[i], name: losoNames[i] })).filter(x => isFinite(x.p) && isFinite(x.a));
    const cleanPreds = validIdx.map(x => x.p);
    const cleanActuals = validIdx.map(x => x.a);
    const cleanSeasons = validIdx.map(x => x.s);
    const cleanNames = validIdx.map(x => x.name);

    // Metrics
    const r2 = cleanActuals.length >= 5 ? cvR2(cleanActuals, cleanPreds) : 0;
    const mae = cleanActuals.length >= 5 ? cvMae(cleanActuals, cleanPreds) : 0;

    // Top-N classification
    const topNResults: Record<number, { precision: number; recall: number; n: number }> = {};
    for (const threshold of TOP_N_THRESHOLDS) {
      let totalPrecision = 0, classCount = 0;
      for (const held of seasons) {
        const classIdx = cleanActuals.map((_, i) => i).filter(i => cleanSeasons[i] === held);
        if (classIdx.length < threshold) continue;
        const actualTopN = new Set(classIdx.map(i => ({ i, ppg: cleanActuals[i] })).sort((a, b) => b.ppg - a.ppg).slice(0, threshold).map(x => x.i));
        const predTopN = new Set(classIdx.map(i => ({ i, ppg: cleanPreds[i] })).sort((a, b) => b.ppg - a.ppg).slice(0, threshold).map(x => x.i));
        let overlap = 0;
        for (const i of predTopN) if (actualTopN.has(i)) overlap++;
        totalPrecision += overlap / threshold;
        classCount++;
      }
      topNResults[threshold] = {
        precision: classCount > 0 ? Math.round(totalPrecision / classCount * 1000) / 10 : 0,
        recall: classCount > 0 ? Math.round(totalPrecision / classCount * 1000) / 10 : 0,
        n: classCount,
      };
    }

    // Rank correlation
    const predRanks = rankArray(cleanPreds.map(p => -p));
    const actualRanks = rankArray(cleanActuals.map(a => -a));
    const rankCorr = spearman(predRanks, actualRanks);

    // Residual std
    const residuals = cleanActuals.map((a, i) => a - cleanPreds[i]);
    const residualMean = residuals.reduce((s, r) => s + r, 0) / residuals.length;
    const residualStd = Math.sqrt(residuals.reduce((s, r) => s + (r - residualMean) ** 2, 0) / residuals.length);

    // Threshold hit-rate table
    const thresholdConfig = PPG_THRESHOLD_CONFIG[pos];
    const thresholdTable: RookieCareerModelResult['thresholdTable'] = {
      thresholds: thresholdConfig.thresholds, tiers: [],
    };
    for (const tier of thresholdConfig.tiers) {
      const tierIdx = cleanPreds.map((p, i) => ({ pred: p, actual: cleanActuals[i] })).filter(x => x.pred >= tier.min && x.pred < tier.max);
      const n = tierIdx.length;
      const hitRates = thresholdConfig.thresholds.map(thresh => {
        if (n === 0) return 0;
        return Math.round(tierIdx.filter(x => x.actual >= thresh).length / n * 1000) / 10;
      });
      thresholdTable.tiers.push({ label: tier.label, min: tier.min, max: tier.max, n, hitRates });
    }

    // Build backtest rows with threshold probs, combined score, percentile, tier
    const TIER_PERCENTILES = [95, 85, 70, 50, 30, 15];
    const backtestRaw: RookieCareerBacktestRow[] = cleanPreds.map((pred, i) => {
      const probs: Record<number, number> = {};
      if (residualStd > 0) {
        for (const t of thresholdConfig.thresholds) {
          const z = (t - pred) / residualStd;
          probs[t] = Math.round((1 - normalCdf(z)) * 1000) / 10;
        }
      }
      const probValues = thresholdConfig.thresholds.map(t => probs[t] || 0);
      const meanProb = probValues.length > 0 ? probValues.reduce((s, v) => s + v, 0) / probValues.length : 0;
      return {
        name: cleanNames[i],
        position: pos,
        draftSeason: cleanSeasons[i],
        actualPPG: Math.round(cleanActuals[i] * 10) / 10,
        predictedPPG: Math.round(pred * 10) / 10,
        combinedScore: Math.round((pred * 3 + meanProb * 0.3) * 10) / 10,
        percentile: 0,
        modelTier: 0,
        thresholdProbs: probs,
      };
    });
    // Sort by combined score, assign percentile and tier per draft class
    backtestRaw.sort((a, b) => b.combinedScore - a.combinedScore);
    for (let i = 0; i < backtestRaw.length; i++) {
      backtestRaw[i].percentile = Math.round((1 - i / backtestRaw.length) * 100);
      const pct = backtestRaw[i].percentile;
      if (pct >= TIER_PERCENTILES[0]) backtestRaw[i].modelTier = 1;
      else if (pct >= TIER_PERCENTILES[1]) backtestRaw[i].modelTier = 2;
      else if (pct >= TIER_PERCENTILES[2]) backtestRaw[i].modelTier = 3;
      else if (pct >= TIER_PERCENTILES[3]) backtestRaw[i].modelTier = 4;
      else if (pct >= TIER_PERCENTILES[4]) backtestRaw[i].modelTier = 5;
      else if (pct >= TIER_PERCENTILES[5]) backtestRaw[i].modelTier = 6;
      else backtestRaw[i].modelTier = 7;
    }

    // Train final model on ALL data
    const XAll = posRows.map(r => featureKeys.map(k => r.features[k] || 0));
    const yAll = posRows.map(r => r.best2of3PPG);
    const finalRidge = trainRidgeRegression(XAll, yAll, featureKeys, 5);
    let finalGBM: BaggedGBM | null = null;
    if (posRows.length >= 40) {
      finalGBM = trainBaggedGBM(XAll, yAll, featureKeys, {
        nEstimators: 60, learningRate: 0.04, maxDepth: 2,
        subsample: 0.8, minSamplesLeaf: Math.max(3, Math.round(posRows.length * 0.08)),
        seed: 42,
      }, 5);
    }

    // Feature importance from ridge coefficients (|standardized coeff|)
    const fi = featureKeys.map((key, i) => ({
      key,
      importance: Math.abs(finalRidge.coefficients[i] || 0),
    })).sort((a, b) => b.importance - a.importance);
    const fiTotal = fi.reduce((s, f) => s + f.importance, 0);
    const featureImportance = fi.map(f => ({
      key: f.key,
      importance: fiTotal > 0 ? Math.round(f.importance / fiTotal * 1000) / 1000 : 0,
    }));

    results[pos] = {
      n: posRows.length,
      cvR2: r2,
      cvMAE: mae,
      rankCorr: Math.round(rankCorr * 1000) / 1000,
      topN: topNResults,
      seasons: seasons.length,
      featureKeys,
      featureImportance,
      residualStd: Math.round(residualStd * 100) / 100,
      thresholds: thresholdConfig.thresholds,
      thresholdTable,
      backtestRows: backtestRaw,
      ridgeModel: finalRidge,
      gbmModel: finalGBM,
    };
  }

  return results;
}
