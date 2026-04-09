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
/**
 * Predict a rookie's best-2-of-3 PPG from their features, including the
 * 70/30 blend with the college-only companion model when present.
 * Use this helper wherever a rookie career model is applied at scoring time
 * to keep the blend consistent between LOSO backtest and live predictions.
 */
export function predictRookieCareerPPG(
  cm: RookieCareerModelResult,
  features: Record<string, number>,
): number {
  if (!cm?.ridgeModel) return 0;
  const mainRidge = predict(cm.ridgeModel as any, features).predicted;
  const mainPred = cm.gbmModel
    ? predictBaggedGBM(cm.gbmModel, features).predicted * 0.5 + mainRidge * 0.5
    : mainRidge;
  const w = cm.companionBlendWeight || 0;
  if (w > 0 && cm.ridgeModelCompanion) {
    const coRidge = predict(cm.ridgeModelCompanion as any, features).predicted;
    const coPred = cm.gbmModelCompanion
      ? predictBaggedGBM(cm.gbmModelCompanion, features).predicted * 0.5 + coRidge * 0.5
      : coRidge;
    return Math.max(0, mainPred * (1 - w) + coPred * w);
  }
  return Math.max(0, mainPred);
}

/**
 * Empirical threshold probability using the LOSO residual distribution.
 *
 * For each residual r in losoResiduals, (predicted + r) is a plausible
 * realized outcome given our model. The probability of exceeding a
 * threshold T is just the fraction of residuals for which predicted+r ≥ T.
 *
 * This replaces the normal-approximation P(PPG ≥ T) = 1 - Φ((T - predicted)
 * / σ) used previously. The residual distribution is typically asymmetric
 * — a model that nails the mean still has long-tailed booms and busts the
 * Gaussian assumption can't capture. Empirical bootstrap gets the shape
 * right with zero parametric assumptions.
 *
 * Falls back to the normal approximation if the residual sample is empty
 * or too small (< 10).
 */
export function bootstrapThresholdProb(
  predicted: number,
  threshold: number,
  cm: Pick<RookieCareerModelResult, 'losoResiduals' | 'residualStd'>,
): number {
  const residuals = cm.losoResiduals;
  if (!residuals || residuals.length < 10) {
    // Fall back to the normal approximation.
    if (!cm.residualStd || cm.residualStd <= 0) return predicted >= threshold ? 1 : 0;
    return 1 - normalCdf((threshold - predicted) / cm.residualStd);
  }
  let hits = 0;
  for (const r of residuals) {
    if (predicted + r >= threshold) hits++;
  }
  return hits / residuals.length;
}

/**
 * Predict best-2-of-3 PPG with quantile uncertainty bands derived from
 * the LOSO residual distribution. Returns the point prediction plus p25,
 * p75 (interquartile range) and p10, p90 (wider 80% band).
 *
 * Assumes homoscedastic residuals — the same band applies regardless of
 * the prediction level. A heteroscedastic version would bin residuals by
 * prediction tier; we can add that later if the residual-vs-prediction
 * plot shows significant non-uniformity.
 */
export function predictRookieCareerPPGWithBands(
  cm: RookieCareerModelResult,
  features: Record<string, number>,
): { predicted: number; p10: number; p25: number; p75: number; p90: number } {
  const predicted = predictRookieCareerPPG(cm, features);
  const q = cm.residualQuantiles || { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0 };
  return {
    predicted,
    p10: Math.max(0, predicted + q.p10),
    p25: Math.max(0, predicted + q.p25),
    p75: Math.max(0, predicted + q.p75),
    p90: Math.max(0, predicted + q.p90),
  };
}

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
  features?: Record<string, number>; // pre-draft features used by the model
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
  // Sorted LOSO residuals (actual − predicted) for empirical bootstrap
  // of threshold probabilities and quantile uncertainty bands. Replaces
  // the normal-approximation σ for probability queries; the residual
  // distribution is often asymmetric (more downside than upside at the
  // top end, more upside than downside at the bottom) and the normal
  // approximation understates that.
  losoResiduals: number[];
  // Residual quantiles used for uncertainty bands on predictions.
  // p25 and p75 give the interquartile range; p10 and p90 give a wider
  // 80% confidence band.
  residualQuantiles: { p10: number; p25: number; p50: number; p75: number; p90: number };
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
  // College-only companion (blended 70/30 with main model at scoring time)
  ridgeModelCompanion?: unknown;
  gbmModelCompanion?: BaggedGBM | null;
  companionFeatureKeys?: string[];
  companionBlendWeight?: number;
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
  options?: { onlyPositions?: string[] },
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
    if (yil <= 1) {
      // Derive actual draft season from yearsInLeague: draftSeason = season - yil
      const derivedDraftSeason = row.season - yil;
      if (entry.draftSeason === 0 || derivedDraftSeason < entry.draftSeason) {
        entry.draftSeason = derivedDraftSeason;
        entry.features = { ...row.features };
      }
    }
  }

  // Fix false rookies: players with yil=0 across multiple seasons are UDFAs
  // without draft data, not actual rookies. Their real "draft season" is their
  // earliest appearance — only that year counts as their rookie season.
  for (const [, entry] of careerMap) {
    if (entry.draftSeason === 0) continue;
    const seasons = entry.seasonPPGs.map(s => s.season).sort((a, b) => a - b);
    const earliestSeason = seasons[0];
    // If draftSeason is NOT their earliest season, something is wrong —
    // they appeared before their supposed draft year
    if (earliestSeason < entry.draftSeason) {
      entry.draftSeason = earliestSeason;
    }
    // If they appear in 3+ seasons, they're definitely not a recent rookie
    // whose career we're trying to predict — use earliest season
    if (seasons.length >= 3 && entry.draftSeason > earliestSeason) {
      entry.draftSeason = earliestSeason;
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
    // Filter to actual rookies: yearsInLeague <= 1 in their draft-year row,
    // AND they don't appear in seasons before their derived draft season
    // (which would indicate they're a veteran with bad yil data)
    const yil = entry.features.yearsInLeague ?? 99;
    if (yil > 1) continue;
    const allSeasons = entry.seasonPPGs.map(s => s.season).sort((a, b) => a - b);
    const hasPreDraftSeasons = allSeasons.some(s => s < entry.draftSeason);
    if (hasPreDraftSeasons) continue; // veteran with yil=0 bug
    // Players with nflDraftPick=300 (default/missing) AND age=0 (no draft data)
    // are undrafted veterans without draft records — not actual rookies.
    // Real drafted rookies always have a draft pick and draft age in the data.
    const pick = entry.features.nflDraftPick || 300;
    const age = entry.features.age || 0;
    if (pick >= 300 && age === 0) continue;
    // Compute derived features from existing ones (avoids cache rebuild)
    const f = { ...entry.features };
    f.logDraftPick = Math.log(pick);
    f.invDraftPick = 1 / pick;
    f.draftPickXEarlyDeclare = (f.collegeEarlyDeclare || 0) * (1 / pick);
    // Late-round breakout interaction: lifts high-producing late picks.
    // Zero inside ~pick 55 (ln 55 ≈ 4.0), positive outside scaled by dominator.
    f.collegeDominatorXLateRound = (f.collegeDominatorRating || 0) * Math.max(0, Math.log(pick) - 4.0);
    // draftPickPct is populated upstream in buildFeatureMatrix against the
    // FULL nflverse draft class (avoids survivor bias). Default to 1.0
    // (latest pick) for any row the upstream lookup missed.
    if (f.draftPickPct == null) f.draftPickPct = 1;

    // ── QB accuracy features derived from stashed raw aggregates ─────
    // These were added in PR #105 to enable "model-cache-only" rebuilds
    // for features that are pure arithmetic over already-computed totals.
    // Non-QB positions get 0 (they won't have pass attempts anyway).
    const rawPassAtt = Number(f._rawCareerPassAtt) || 0;
    const rawPassComp = Number(f._rawCareerPassCompletions) || 0;
    const rawPassYds = Number(f._rawCareerPassYds) || 0;
    const rawTeamPassAtt = Number(f._rawTeamPassAtt) || 0;
    const rawTeamPassComp = Number(f._rawTeamPassCompletions) || 0;
    f.collegeCompletionPct = rawPassAtt > 0
      ? Math.round((rawPassComp / rawPassAtt) * 1000) / 1000
      : 0;
    const teamComp = rawTeamPassAtt > 0 ? rawTeamPassComp / rawTeamPassAtt : 0;
    f.collegeCompletionPctOverTeam = (f.collegeCompletionPct > 0 && teamComp > 0)
      ? Math.round((f.collegeCompletionPct - teamComp) * 1000) / 1000
      : 0;
    f.collegeYdsPerCompletion = rawPassComp > 0
      ? Math.round((rawPassYds / rawPassComp) * 100) / 100
      : 0;

    careerRows.push({ name: entry.name, position: entry.position, draftSeason: entry.draftSeason, best2of3PPG, features: f });
  }

  // Step 4: Per-position training
  // Per-position hyperparameters. Small-sample positions (QB n≈133, TE n≈207)
  // want more Ridge regularization + shallower GBMs to avoid overfitting.
  // Larger-sample positions (WR n≈456, RB n≈315) can handle more capacity.
  const POS_HYPERPARAMS: Record<string, {
    ridgeLambda: number;
    gbmEstimators: number;
    gbmLR: number;
    gbmDepth: number;
    minLeafPct: number;
  }> = {
    QB: { ridgeLambda: 15, gbmEstimators: 40,  gbmLR: 0.04, gbmDepth: 2, minLeafPct: 0.12 },
    // RB: depth-3 + 80 trees overfit on the mid-sized sample (regressed
    // LOSO R² by ~0.01 vs the depth-2 / 60-tree / λ=5 baseline). Reverted
    // to the conservative config that worked before the batch.
    RB: { ridgeLambda: 5,  gbmEstimators: 60,  gbmLR: 0.04, gbmDepth: 2, minLeafPct: 0.08 },
    WR: { ridgeLambda: 8,  gbmEstimators: 100, gbmLR: 0.05, gbmDepth: 3, minLeafPct: 0.05 },
    TE: { ridgeLambda: 20, gbmEstimators: 40,  gbmLR: 0.04, gbmDepth: 2, minLeafPct: 0.12 },
  };

  const results: Record<string, RookieCareerModelResult> = {};

  const positionsToTrain = options?.onlyPositions || ['QB', 'RB', 'WR', 'TE'];
  for (const pos of positionsToTrain) {
    const posRows = careerRows.filter(r => r.position === pos);
    if (posRows.length < 10) continue;
    const featureKeys = PRE_DRAFT_ROOKIE_FEATURES[pos] || [];
    if (featureKeys.length === 0) continue;

    // College-only companion feature set: excludes all draft-capital features
    // (including the late-round breakout interaction) so the companion model
    // is forced to rely purely on college production signals. Blended 70/30
    // with the main model to catch late-round breakouts the draft-capital-
    // driven main model confidently mispredicts (Tyreek Hill, Puka Nacua).
    const DRAFT_CAPITAL_KEYS = new Set([
      'logDraftPick', 'invDraftPick', 'draftPickXEarlyDeclare',
      'collegeDominatorXLateRound',
    ]);
    const collegeOnlyKeys = featureKeys.filter(k => !DRAFT_CAPITAL_KEYS.has(k));
    const useCollegeCompanion = collegeOnlyKeys.length >= 4 && (pos === 'WR' || pos === 'RB');

    const hyper = POS_HYPERPARAMS[pos] || POS_HYPERPARAMS.WR;

    const seasons = [...new Set(posRows.map(r => r.draftSeason))].sort();
    const thresholdConfig = PPG_THRESHOLD_CONFIG[pos];

    // ── Temporal sample weighting via row duplication ─────────────────
    // NFL offense has shifted heavily toward passing since ~2012. Training
    // on 2010 rookies with equal weight to 2024 rookies washes out the
    // modern signal. Duplicate recent rows so they dominate the loss:
    //   0-3 years ago: 3x, 4-7: 2x, 8+: 1x. Applied only to the training
    //   fold (never to the held-out test fold) so LOSO stays honest.
    //
    // RB is excluded: the position has had enough modern-era turnover
    // (role churn, "dead zone", high bust rates) that upweighting recent
    // classes introduces more noise than signal. Measured -0.01 LOSO R²
    // vs an unweighted baseline.
    const useRecencyWeighting = pos !== 'RB';
    const maxSeason = Math.max(...seasons);
    const recencyWeight = (season: number): number => {
      if (!useRecencyWeighting) return 1;
      const gap = maxSeason - season;
      if (gap <= 3) return 3;
      if (gap <= 7) return 2;
      return 1;
    };
    const expand = <T extends { draftSeason: number }>(rows: T[]): T[] => {
      if (!useRecencyWeighting) return rows;
      const out: T[] = [];
      for (const r of rows) {
        const w = recencyWeight(r.draftSeason);
        for (let i = 0; i < w; i++) out.push(r);
      }
      return out;
    };

    // ── LOSO CV: collect regression predictions AND per-threshold class probs ──
    const losoData: Array<{
      name: string; season: number; actual: number;
      regPred: number;
      threshProbs: Record<number, number>;
      boomProb: number;  // filled in second pass
      bustProb: number;
      features: number[];  // raw feature vector for boom/bust training
      featureRecord: Record<string, number>; // keyed features for player cards
    }> = [];

    for (const held of seasons) {
      const trainRRaw = posRows.filter(r => r.draftSeason !== held);
      const testR = posRows.filter(r => r.draftSeason === held);
      if (trainRRaw.length < 10 || testR.length === 0) continue;
      // Temporal recency upsampling (training fold only).
      const trainR = expand(trainRRaw);

      const Xtr = trainR.map(r => featureKeys.map(k => r.features[k] || 0));
      const Xte = testR.map(r => featureKeys.map(k => r.features[k] || 0));

      // Regression model (for predicted PPG display)
      const ytrReg = trainR.map(r => r.best2of3PPG);
      const ridgeReg = trainRidgeRegression(Xtr, ytrReg, featureKeys, hyper.ridgeLambda);
      let regPreds: number[];
      const mainPreds: number[] = [];
      if (trainR.length >= 40) {
        const gbmReg = trainBaggedGBM(Xtr, ytrReg, featureKeys, {
          nEstimators: hyper.gbmEstimators, learningRate: hyper.gbmLR, maxDepth: hyper.gbmDepth,
          subsample: 0.8, minSamplesLeaf: Math.max(3, Math.round(trainR.length * hyper.minLeafPct)),
          seed: 42,
        }, 5);
        for (const x of Xte) {
          const feat: Record<string, number> = {};
          featureKeys.forEach((k, j) => { feat[k] = isFinite(x[j]) ? x[j] : 0; });
          const p = predictBaggedGBM(gbmReg, feat).predicted * 0.5 + predict(ridgeReg, feat).predicted * 0.5;
          mainPreds.push(isFinite(p) ? Math.max(0, p) : 0);
        }
      } else {
        for (const x of Xte) {
          const feat: Record<string, number> = {};
          featureKeys.forEach((k, j) => { feat[k] = isFinite(x[j]) ? x[j] : 0; });
          const p = predict(ridgeReg, feat).predicted;
          mainPreds.push(isFinite(p) ? Math.max(0, p) : 0);
        }
      }

      // ── College-only companion model ────────────────────────────────
      // Same architecture, but trained on a feature set with all draft-
      // capital features removed. Blended 70/30 with the main model so
      // that college production can partially override draft capital
      // when the main model is confidently wrong on late-round breakouts.
      let companionPreds: number[] | null = null;
      if (useCollegeCompanion) {
        const XtrCo = trainR.map(r => collegeOnlyKeys.map(k => r.features[k] || 0));
        const XteCo = testR.map(r => collegeOnlyKeys.map(k => r.features[k] || 0));
        const ridgeCo = trainRidgeRegression(XtrCo, ytrReg, collegeOnlyKeys, hyper.ridgeLambda);
        if (trainR.length >= 40) {
          const gbmCo = trainBaggedGBM(XtrCo, ytrReg, collegeOnlyKeys, {
            nEstimators: hyper.gbmEstimators, learningRate: hyper.gbmLR, maxDepth: hyper.gbmDepth,
            subsample: 0.8, minSamplesLeaf: Math.max(3, Math.round(trainR.length * hyper.minLeafPct)),
            seed: 43,
          }, 5);
          companionPreds = XteCo.map((x) => {
            const feat: Record<string, number> = {};
            collegeOnlyKeys.forEach((k, j) => { feat[k] = isFinite(x[j]) ? x[j] : 0; });
            const p = predictBaggedGBM(gbmCo, feat).predicted * 0.5 + predict(ridgeCo, feat).predicted * 0.5;
            return isFinite(p) ? Math.max(0, p) : 0;
          });
        } else {
          companionPreds = XteCo.map((x) => {
            const feat: Record<string, number> = {};
            collegeOnlyKeys.forEach((k, j) => { feat[k] = isFinite(x[j]) ? x[j] : 0; });
            const p = predict(ridgeCo, feat).predicted;
            return isFinite(p) ? Math.max(0, p) : 0;
          });
        }
      }

      // Blend main and companion: 70/30 if companion ran, else main only.
      regPreds = mainPreds.map((m, i) => {
        if (!companionPreds) return m;
        return Math.round((m * 0.7 + companionPreds[i] * 0.3) * 100) / 100;
      });

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

        const ridgeBin = trainRidgeRegression(Xtr, ytrBin, featureKeys, hyper.ridgeLambda);
        let binPreds: number[];

        if (trainR.length >= 40) {
          const gbmBin = trainBaggedGBM(Xtr, ytrBin, featureKeys, {
            nEstimators: hyper.gbmEstimators, learningRate: hyper.gbmLR, maxDepth: hyper.gbmDepth,
            subsample: 0.8, minSamplesLeaf: Math.max(5, Math.round(trainR.length * hyper.minLeafPct * 1.25)),
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
        // Build keyed feature record for player cards
        const fr: Record<string, number> = {};
        featureKeys.forEach((k, j) => { fr[k] = Xte[i][j]; });
        // Also include the raw features from the original row
        Object.assign(fr, testR[i].features);

        losoData.push({
          name: testR[i].name,
          season: held,
          actual: testR[i].best2of3PPG,
          regPred: regPreds[i],
          threshProbs: threshProbs[i],
          boomProb: 0,
          bustProb: 0,
          features: Xte[i],
          featureRecord: fr,
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
    // Sorted residuals for empirical bootstrap of threshold probabilities
    // and quantile bands. Kept separately from residualStd so both the
    // normal-approx (legacy) and bootstrap paths are available.
    const sortedResiduals = [...residuals].sort((a, b) => a - b);
    const quantile = (q: number): number => {
      if (sortedResiduals.length === 0) return 0;
      const idx = Math.max(0, Math.min(sortedResiduals.length - 1,
        Math.round(q * (sortedResiduals.length - 1))));
      return Math.round(sortedResiduals[idx] * 100) / 100;
    };
    const residualQuantiles = {
      p10: quantile(0.10),
      p25: quantile(0.25),
      p50: quantile(0.50),
      p75: quantile(0.75),
      p90: quantile(0.90),
    };

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
        features: d.featureRecord,
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
      // Tier assignment from percentile (consistent across all views)
      const pctl = backtestRaw[i].percentile;
      if (pctl >= 95) backtestRaw[i].modelTier = 1;       // Alpha
      else if (pctl >= 85) backtestRaw[i].modelTier = 2;  // Blue Chip
      else if (pctl >= 70) backtestRaw[i].modelTier = 3;  // Starter
      else if (pctl >= 50) backtestRaw[i].modelTier = 4;  // Contributor
      else if (pctl >= 30) backtestRaw[i].modelTier = 5;  // Depth
      else backtestRaw[i].modelTier = 6;                   // Longshot
    }

    // ── Train final models on ALL data (for 2026 scoring) ──
    // Use the recency-expanded row set so final models match the LOSO
    // blend's temporal weighting.
    const posRowsExpanded = expand(posRows);
    const XAll = posRowsExpanded.map(r => featureKeys.map(k => r.features[k] || 0));
    const yAllReg = posRowsExpanded.map(r => r.best2of3PPG);
    const nAll = posRowsExpanded.length;

    // Regression model (for predicted PPG display)
    const finalRidge = trainRidgeRegression(XAll, yAllReg, featureKeys, hyper.ridgeLambda);
    let finalGBM: BaggedGBM | null = null;
    if (nAll >= 40) {
      finalGBM = trainBaggedGBM(XAll, yAllReg, featureKeys, {
        nEstimators: hyper.gbmEstimators, learningRate: hyper.gbmLR, maxDepth: hyper.gbmDepth,
        subsample: 0.8, minSamplesLeaf: Math.max(3, Math.round(nAll * hyper.minLeafPct)),
        seed: 42,
      }, 5);
    }

    // Companion college-only final model (matching the LOSO blend).
    let finalRidgeCo: ReturnType<typeof trainRidgeRegression> | null = null;
    let finalGBMCo: BaggedGBM | null = null;
    if (useCollegeCompanion) {
      const XAllCo = posRowsExpanded.map(r => collegeOnlyKeys.map(k => r.features[k] || 0));
      finalRidgeCo = trainRidgeRegression(XAllCo, yAllReg, collegeOnlyKeys, hyper.ridgeLambda);
      if (nAll >= 40) {
        finalGBMCo = trainBaggedGBM(XAllCo, yAllReg, collegeOnlyKeys, {
          nEstimators: hyper.gbmEstimators, learningRate: hyper.gbmLR, maxDepth: hyper.gbmDepth,
          subsample: 0.8, minSamplesLeaf: Math.max(3, Math.round(nAll * hyper.minLeafPct)),
          seed: 43,
        }, 5);
      }
    }

    // Per-threshold classifiers
    const thresholdModels: Record<number, { ridge: unknown; gbm: BaggedGBM | null }> = {};
    for (const thresh of thresholdConfig.thresholds) {
      const yBin = posRowsExpanded.map(r => r.best2of3PPG >= thresh ? 1 : 0);
      const posRate = yBin.filter(y => y === 1).length / yBin.length;
      if (posRate < 0.03 || posRate > 0.97) continue; // skip extreme imbalance

      const ridgeBin = trainRidgeRegression(XAll, yBin, featureKeys, hyper.ridgeLambda);
      let gbmBin: BaggedGBM | null = null;
      if (nAll >= 40) {
        gbmBin = trainBaggedGBM(XAll, yBin, featureKeys, {
          nEstimators: hyper.gbmEstimators, learningRate: hyper.gbmLR, maxDepth: hyper.gbmDepth,
          subsample: 0.8, minSamplesLeaf: Math.max(5, Math.round(nAll * hyper.minLeafPct * 1.25)),
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
      losoResiduals: sortedResiduals.map(r => Math.round(r * 100) / 100),
      residualQuantiles,
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
      ridgeModelCompanion: finalRidgeCo || undefined,
      gbmModelCompanion: finalGBMCo,
      companionFeatureKeys: useCollegeCompanion ? collegeOnlyKeys : undefined,
      companionBlendWeight: useCollegeCompanion ? 0.3 : 0,
      topN: {},
    };
  }

  return results;
}
