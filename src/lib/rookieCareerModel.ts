/**
 * Rookie career model: trains per-position, per-threshold binary classifiers
 * to predict P(best 2-of-3 PPG >= threshold) in a rookie's first 3 NFL years.
 * Uses only pre-draft features. Each threshold gets its own model.
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

// Position-specific PPG thresholds — focused on where classifiers have signal
// Dropped thresholds where base rate > 70% (too easy) or < 5% (too rare)
export const PPG_THRESHOLD_CONFIG: Record<string, {
  thresholds: number[];
  tiers: Array<{ label: string; min: number; max: number }>;
}> = {
  QB: {
    thresholds: [16, 18, 20, 22],
    tiers: [
      { label: 'Tier 1', min: 20, max: Infinity },
      { label: 'Tier 2', min: 17, max: 20 },
      { label: 'Tier 3', min: 14, max: 17 },
      { label: 'Tier 4', min: 11, max: 14 },
      { label: 'Tier 5', min: 0, max: 11 },
    ],
  },
  RB: {
    thresholds: [12, 14, 16, 18],
    tiers: [
      { label: 'Tier 1', min: 14, max: Infinity },
      { label: 'Tier 2', min: 11, max: 14 },
      { label: 'Tier 3', min: 8, max: 11 },
      { label: 'Tier 4', min: 5, max: 8 },
      { label: 'Tier 5', min: 0, max: 5 },
    ],
  },
  WR: {
    thresholds: [12, 14, 16, 18],
    tiers: [
      { label: 'Tier 1', min: 14, max: Infinity },
      { label: 'Tier 2', min: 11, max: 14 },
      { label: 'Tier 3', min: 8, max: 11 },
      { label: 'Tier 4', min: 5, max: 8 },
      { label: 'Tier 5', min: 0, max: 5 },
    ],
  },
  TE: {
    thresholds: [8, 9, 10, 11],
    tiers: [
      { label: 'Tier 1', min: 10, max: Infinity },
      { label: 'Tier 2', min: 8, max: 10 },
      { label: 'Tier 3', min: 6, max: 8 },
      { label: 'Tier 4', min: 4, max: 6 },
      { label: 'Tier 5', min: 0, max: 4 },
    ],
  },
};

export interface RookieCareerBacktestRow {
  name: string;
  position: string;
  draftSeason: number;
  actualPPG: number;
  predictedPPG: number;
  combinedScore: number;
  percentile: number;
  modelTier: number;
  thresholdProbs: Record<number, number>;
  boomProb: number;  // P(actual > predicted + MAE) — outperform probability
  bustProb: number;  // P(actual < predicted - MAE) — underperform probability
}

export interface ThresholdModelMetrics {
  threshold: number;
  accuracy: number;    // % correct classification
  precision: number;   // of those predicted >50%, how many actually hit
  recall: number;      // of those who hit, how many were predicted >50%
  brierScore: number;  // mean squared error of probability predictions (lower = better)
  baseRate: number;    // % of rookies who actually hit this threshold
  auc: number;         // approximate AUC-ROC
}

export interface RookieCareerModelResult {
  n: number;
  cvR2: number;        // kept from regression model for comparison
  cvMAE: number;
  rankCorr: number;
  seasons: number;
  featureKeys: string[];
  featureImportance: Array<{ key: string; importance: number; direction: 'positive' | 'negative' }>;
  residualStd: number;
  thresholds: number[];
  thresholdMetrics: ThresholdModelMetrics[];  // per-threshold classification metrics
  thresholdTable: {
    thresholds: number[];
    tiers: Array<{ label: string; min: number; max: number; n: number; hitRates: number[] }>;
  };
  backtestRows: RookieCareerBacktestRow[];
  // Per-threshold trained models for 2026 scoring
  thresholdModels: Record<number, { ridge: unknown; gbm: BaggedGBM | null }>;
  // Boom/bust overlay models
  boomModel?: { ridge: unknown; gbm: BaggedGBM | null };
  bustModel?: { ridge: unknown; gbm: BaggedGBM | null };
  boomRate: number;
  bustRate: number;
  boomMetrics?: { auc: number; accuracy: number; precision: number; recall: number };
  bustMetrics?: { auc: number; accuracy: number; precision: number; recall: number };
  boomFeatureImportance?: Array<{ key: string; importance: number; direction: 'positive' | 'negative' }>;
  bustFeatureImportance?: Array<{ key: string; importance: number; direction: 'positive' | 'negative' }>;
  // Keep regression model too for predicted PPG display
  ridgeModel?: unknown;
  gbmModel?: BaggedGBM | null;
  // Legacy fields kept for compatibility
  topN: Record<number, { precision: number; recall: number; n: number }>;
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

// Clamp prediction to [0, 1] range for probability outputs
function clampProb(p: number): number {
  return Math.max(0, Math.min(1, p));
}

// Approximate AUC from predicted probabilities and binary labels
function approxAUC(probs: number[], labels: number[]): number {
  const pairs = probs.map((p, i) => ({ p, label: labels[i] }));
  pairs.sort((a, b) => b.p - a.p);
  let tp = 0, fp = 0;
  const totalPos = labels.filter(l => l === 1).length;
  const totalNeg = labels.length - totalPos;
  if (totalPos === 0 || totalNeg === 0) return 0.5;
  let auc = 0;
  let prevFPR = 0;
  for (const pair of pairs) {
    if (pair.label === 1) tp++;
    else { fp++; const fpr = fp / totalNeg; auc += (fpr - prevFPR) * (tp / totalPos); prevFPR = fpr; }
  }
  return Math.min(1, Math.max(0, auc));
}

/**
 * Train rookie career models: per-threshold binary classifiers + regression.
 * For each position and each PPG threshold, trains a model to predict
 * P(best 2-of-3 PPG >= threshold). Uses LOSO cross-validation.
 */
export function trainRookieCareerModels(
  rows: PlayerRow[],
): Record<string, RookieCareerModelResult> {

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
    if (first3.length === 0) continue;
    const qualifying = first3.filter(s => s.games >= 4);
    if (qualifying.length === 0) continue;
    // Best 2-of-3 PPG: average of top 2 qualifying seasons, or single season if only 1 available
    const best2 = qualifying.slice(0, 2);
    const best2of3PPG = best2.length >= 2
      ? Math.round((best2[0].ppg + best2[1].ppg) / 2 * 100) / 100
      : Math.round(best2[0].ppg * 100) / 100;
    const yil = entry.features.yearsInLeague ?? 99;
    if (yil > 1) continue;
    // Compute derived features from existing ones (avoids cache rebuild)
    const f = { ...entry.features };
    const pick = f.nflDraftPick || 300;
    f.logDraftPick = Math.log(pick);
    f.invDraftPick = 1 / pick;
    f.draftPickXEarlyDeclare = (f.collegeEarlyDeclare || 0) * (1 / pick);
    careerRows.push({ name: entry.name, position: entry.position, draftSeason: entry.draftSeason, best2of3PPG, features: f });
  }

  // Step 4: Per-position training
  const results: Record<string, RookieCareerModelResult> = {};

  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    const posRows = careerRows.filter(r => r.position === pos);
    if (posRows.length < 10) continue;
    const featureKeys = PRE_DRAFT_ROOKIE_FEATURES[pos] || [];
    if (featureKeys.length === 0) continue;

    const seasons = [...new Set(posRows.map(r => r.draftSeason))].sort();
    const thresholdConfig = PPG_THRESHOLD_CONFIG[pos];

    // ── LOSO CV: collect regression predictions AND per-threshold class probs ──
    const losoData: Array<{
      name: string; season: number; actual: number;
      regPred: number;
      threshProbs: Record<number, number>;
      boomProb: number;  // filled in second pass
      bustProb: number;
      features: number[];  // raw feature vector for boom/bust training
    }> = [];

    for (const held of seasons) {
      const trainR = posRows.filter(r => r.draftSeason !== held);
      const testR = posRows.filter(r => r.draftSeason === held);
      if (trainR.length < 10 || testR.length === 0) continue;

      const Xtr = trainR.map(r => featureKeys.map(k => r.features[k] || 0));
      const Xte = testR.map(r => featureKeys.map(k => r.features[k] || 0));

      // Regression model (for predicted PPG display)
      const ytrReg = trainR.map(r => r.best2of3PPG);
      const ridgeReg = trainRidgeRegression(Xtr, ytrReg, featureKeys, 5);
      let regPreds: number[];
      if (trainR.length >= 40) {
        const gbmReg = trainBaggedGBM(Xtr, ytrReg, featureKeys, {
          nEstimators: 60, learningRate: 0.04, maxDepth: 2,
          subsample: 0.8, minSamplesLeaf: Math.max(3, Math.round(trainR.length * 0.08)),
          seed: 42,
        }, 5);
        regPreds = Xte.map((x) => {
          const feat: Record<string, number> = {};
          featureKeys.forEach((k, j) => { feat[k] = isFinite(x[j]) ? x[j] : 0; });
          const p = predictBaggedGBM(gbmReg, feat).predicted * 0.5 + predict(ridgeReg, feat).predicted * 0.5;
          return isFinite(p) ? Math.max(0, p) : 0;
        });
      } else {
        regPreds = Xte.map((x) => {
          const feat: Record<string, number> = {};
          featureKeys.forEach((k, j) => { feat[k] = isFinite(x[j]) ? x[j] : 0; });
          const p = predict(ridgeReg, feat).predicted;
          return isFinite(p) ? Math.max(0, p) : 0;
        });
      }

      // Per-threshold binary classifiers
      const threshProbs: Record<number, number>[] = testR.map(() => ({}));

      for (const thresh of thresholdConfig.thresholds) {
        const ytrBin = trainR.map(r => r.best2of3PPG >= thresh ? 1 : 0);
        const posRate = ytrBin.filter(y => y === 1).length / ytrBin.length;

        // Skip if too imbalanced (< 5% or > 95% positive rate)
        if (posRate < 0.05 || posRate > 0.95) {
          for (let i = 0; i < testR.length; i++) {
            threshProbs[i][thresh] = Math.round(posRate * 1000) / 10;
          }
          continue;
        }

        const ridgeBin = trainRidgeRegression(Xtr, ytrBin, featureKeys, 5);
        let binPreds: number[];

        if (trainR.length >= 40) {
          const gbmBin = trainBaggedGBM(Xtr, ytrBin, featureKeys, {
            nEstimators: 80, learningRate: 0.03, maxDepth: 2,
            subsample: 0.8, minSamplesLeaf: Math.max(5, Math.round(trainR.length * 0.1)),
            seed: 42,
          }, 5);
          binPreds = Xte.map((x) => {
            const feat: Record<string, number> = {};
            featureKeys.forEach((k, j) => { feat[k] = isFinite(x[j]) ? x[j] : 0; });
            const gbmP = clampProb(predictBaggedGBM(gbmBin, feat).predicted);
            const ridgeP = clampProb(predict(ridgeBin, feat).predicted);
            return gbmP * 0.5 + ridgeP * 0.5;
          });
        } else {
          binPreds = Xte.map((x) => {
            const feat: Record<string, number> = {};
            featureKeys.forEach((k, j) => { feat[k] = isFinite(x[j]) ? x[j] : 0; });
            return clampProb(predict(ridgeBin, feat).predicted);
          });
        }

        for (let i = 0; i < testR.length; i++) {
          threshProbs[i][thresh] = Math.round(clampProb(binPreds[i]) * 1000) / 10; // as percentage
        }
      }

      for (let i = 0; i < testR.length; i++) {
        losoData.push({
          name: testR[i].name,
          season: held,
          actual: testR[i].best2of3PPG,
          regPred: regPreds[i],
          threshProbs: threshProbs[i],
          boomProb: 0,
          bustProb: 0,
          features: Xte[i],
        });
      }
    }

    // Filter NaN
    const clean = losoData.filter(d => isFinite(d.regPred) && isFinite(d.actual));

    // Boom/bust rates (computed but classifiers disabled — AUC was sub-50%)
    const quickMAE = clean.reduce((s, d) => s + Math.abs(d.actual - d.regPred), 0) / clean.length;
    const boomThresh = quickMAE * 0.75;
    const nBooms = clean.filter(d => (d.actual - d.regPred) > boomThresh).length;
    const nBusts = clean.filter(d => (d.regPred - d.actual) > boomThresh).length;
    const finalBoomRate = nBooms / clean.length;
    const finalBustRate = nBusts / clean.length;

    // ── Regression metrics (kept for comparison) ──
    const cleanPreds = clean.map(d => d.regPred);
    const cleanActuals = clean.map(d => d.actual);
    const r2 = cleanActuals.length >= 5 ? cvR2(cleanActuals, cleanPreds) : 0;
    const mae = cleanActuals.length >= 5 ? cvMae(cleanActuals, cleanPreds) : 0;
    const predRanks = rankArray(cleanPreds.map(p => -p));
    const actualRanks = rankArray(cleanActuals.map(a => -a));
    const rankCorr = spearman(predRanks, actualRanks);
    const residuals = cleanActuals.map((a, i) => a - cleanPreds[i]);
    const residualMean = residuals.reduce((s, r) => s + r, 0) / residuals.length;
    const residualStd = Math.sqrt(residuals.reduce((s, r) => s + (r - residualMean) ** 2, 0) / residuals.length);

    // ── Per-threshold classification metrics ──
    const thresholdMetrics: ThresholdModelMetrics[] = [];
    for (const thresh of thresholdConfig.thresholds) {
      const probs = clean.map(d => (d.threshProbs[thresh] || 0) / 100); // convert back to 0-1
      const labels = clean.map(d => d.actual >= thresh ? 1 : 0);
      const baseRate = labels.filter(l => l === 1).length / labels.length;

      // Brier score: mean squared error of probability predictions
      const brier = probs.reduce((s, p, i) => s + (p - labels[i]) ** 2, 0) / probs.length;

      // Classification at 50% threshold
      const predicted = probs.map(p => p >= 0.5 ? 1 : 0);
      const tp = predicted.filter((p, i) => p === 1 && labels[i] === 1).length;
      const fp = predicted.filter((p, i) => p === 1 && labels[i] === 0).length;
      const fn = predicted.filter((p, i) => p === 0 && labels[i] === 1).length;
      const correct = predicted.filter((p, i) => p === labels[i]).length;

      thresholdMetrics.push({
        threshold: thresh,
        accuracy: Math.round(correct / labels.length * 1000) / 10,
        precision: tp + fp > 0 ? Math.round(tp / (tp + fp) * 1000) / 10 : 0,
        recall: tp + fn > 0 ? Math.round(tp / (tp + fn) * 1000) / 10 : 0,
        brierScore: Math.round(brier * 1000) / 1000,
        baseRate: Math.round(baseRate * 1000) / 10,
        auc: Math.round(approxAUC(probs, labels) * 1000) / 10,
      });
    }

    // ── Threshold hit-rate table (empirical calibration by tier) ──
    // Tiers weighted toward extremes where model has most conviction
    // Top 10% | Next 20% | Middle 40% | Next 20% | Bottom 10%
    const thresholdTable: RookieCareerModelResult['thresholdTable'] = {
      thresholds: thresholdConfig.thresholds, tiers: [],
    };
    const scoredClean = clean.map(d => {
      const avgProb = thresholdConfig.thresholds.reduce((s, t) => s + (d.threshProbs[t] || 0), 0) / thresholdConfig.thresholds.length;
      return { ...d, avgProb };
    }).sort((a, b) => b.avgProb - a.avgProb);

    const total = scoredClean.length;
    const tierCuts = [
      { label: 'Tier 1', start: 0, end: Math.round(total * 0.10) },
      { label: 'Tier 2', start: Math.round(total * 0.10), end: Math.round(total * 0.30) },
      { label: 'Tier 3', start: Math.round(total * 0.30), end: Math.round(total * 0.70) },
      { label: 'Tier 4', start: Math.round(total * 0.70), end: Math.round(total * 0.90) },
      { label: 'Tier 5', start: Math.round(total * 0.90), end: total },
    ];
    for (const cut of tierCuts) {
      const tierRows = scoredClean.slice(cut.start, cut.end);
      const n = tierRows.length;
      if (n === 0) continue;
      const hitRates = thresholdConfig.thresholds.map(thresh => {
        return Math.round(tierRows.filter(d => d.actual >= thresh).length / n * 1000) / 10;
      });
      thresholdTable.tiers.push({
        label: cut.label, min: tierRows[n - 1].avgProb, max: tierRows[0].avgProb, n, hitRates,
      });
    }

    // ── Backtest rows ──
    const backtestRaw: RookieCareerBacktestRow[] = clean.map(d => {
      const probValues = thresholdConfig.thresholds.map(t => d.threshProbs[t] || 0);
      const meanProb = probValues.reduce((s, v) => s + v, 0) / probValues.length;
      return {
        name: d.name,
        position: pos,
        draftSeason: d.season,
        actualPPG: Math.round(d.actual * 10) / 10,
        predictedPPG: Math.round(d.regPred * 10) / 10,
        combinedScore: meanProb, // raw, will rescale below
        percentile: 0,
        modelTier: 0,
        thresholdProbs: d.threshProbs,
        boomProb: d.boomProb,
        bustProb: d.bustProb,
      };
    });
    // Rescale combined scores to 0-100 (ZAP-comparable)
    const rawScores = backtestRaw.map(r => r.combinedScore);
    const minS = Math.min(...rawScores);
    const maxS = Math.max(...rawScores);
    const rangeS = maxS - minS;
    for (const r of backtestRaw) {
      r.combinedScore = rangeS > 0
        ? Math.round((5 + ((r.combinedScore - minS) / rangeS) * 93) * 10) / 10
        : 50;
    }
    backtestRaw.sort((a, b) => b.combinedScore - a.combinedScore);
    for (let i = 0; i < backtestRaw.length; i++) {
      backtestRaw[i].percentile = Math.round((1 - i / backtestRaw.length) * 100);
      // Score-based tier assignment (ZAP-style bands)
      const s = backtestRaw[i].combinedScore;
      if (s >= 90) backtestRaw[i].modelTier = 1;       // Legendary Performer
      else if (s >= 75) backtestRaw[i].modelTier = 2;  // Elite Producer
      else if (s >= 60) backtestRaw[i].modelTier = 3;  // Weekly Starter
      else if (s >= 40) backtestRaw[i].modelTier = 4;  // Flex Play
      else if (s >= 30) backtestRaw[i].modelTier = 5;  // Benchwarmer
      else if (s >= 20) backtestRaw[i].modelTier = 6;  // Waiver Wire Add
      else backtestRaw[i].modelTier = 7;               // Dart Throw
    }

    // ── Train final models on ALL data (for 2026 scoring) ──
    const XAll = posRows.map(r => featureKeys.map(k => r.features[k] || 0));
    const yAllReg = posRows.map(r => r.best2of3PPG);

    // Regression model (for predicted PPG display)
    const finalRidge = trainRidgeRegression(XAll, yAllReg, featureKeys, 5);
    let finalGBM: BaggedGBM | null = null;
    if (posRows.length >= 40) {
      finalGBM = trainBaggedGBM(XAll, yAllReg, featureKeys, {
        nEstimators: 60, learningRate: 0.04, maxDepth: 2,
        subsample: 0.8, minSamplesLeaf: Math.max(3, Math.round(posRows.length * 0.08)),
        seed: 42,
      }, 5);
    }

    // Per-threshold classifiers
    const thresholdModels: Record<number, { ridge: unknown; gbm: BaggedGBM | null }> = {};
    for (const thresh of thresholdConfig.thresholds) {
      const yBin = posRows.map(r => r.best2of3PPG >= thresh ? 1 : 0);
      const posRate = yBin.filter(y => y === 1).length / yBin.length;
      if (posRate < 0.03 || posRate > 0.97) continue; // skip extreme imbalance

      const ridgeBin = trainRidgeRegression(XAll, yBin, featureKeys, 5);
      let gbmBin: BaggedGBM | null = null;
      if (posRows.length >= 40) {
        gbmBin = trainBaggedGBM(XAll, yBin, featureKeys, {
          nEstimators: 80, learningRate: 0.03, maxDepth: 2,
          subsample: 0.8, minSamplesLeaf: Math.max(5, Math.round(posRows.length * 0.1)),
          seed: 42,
        }, 5);
      }
      thresholdModels[thresh] = { ridge: ridgeBin, gbm: gbmBin };
    }

    // Boom/bust classifiers disabled (AUC was sub-50%)
    const boomModel = undefined;
    const bustModel = undefined;
    const boomMetrics = undefined;
    const bustMetrics = undefined;

    // Feature importance from ridge coefficients (with direction from sign)
    const fi = featureKeys.map((key, i) => ({
      key,
      rawCoeff: finalRidge.coefficients[i] || 0,
      importance: Math.abs(finalRidge.coefficients[i] || 0),
    })).sort((a, b) => b.importance - a.importance);
    const fiTotal = fi.reduce((s, f) => s + f.importance, 0);
    const featureImportance = fi.map(f => ({
      key: f.key,
      importance: fiTotal > 0 ? Math.round(f.importance / fiTotal * 1000) / 1000 : 0,
      direction: (f.rawCoeff >= 0 ? 'positive' : 'negative') as 'positive' | 'negative',
    }));

    results[pos] = {
      n: posRows.length,
      cvR2: r2,
      cvMAE: mae,
      rankCorr: Math.round(rankCorr * 1000) / 1000,
      seasons: seasons.length,
      featureKeys,
      featureImportance,
      residualStd: Math.round(residualStd * 100) / 100,
      thresholds: thresholdConfig.thresholds,
      thresholdMetrics,
      thresholdTable,
      backtestRows: backtestRaw,
      thresholdModels,
      boomModel,
      bustModel,
      boomRate: Math.round(finalBoomRate * 1000) / 10,
      bustRate: Math.round(finalBustRate * 1000) / 10,
      boomMetrics,
      bustMetrics,
      boomFeatureImportance: undefined,
      bustFeatureImportance: undefined,
      ridgeModel: finalRidge,
      gbmModel: finalGBM,
      topN: {},
    };
  }

  return results;
}
