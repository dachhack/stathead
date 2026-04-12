/**
 * KTC time-series forecast utilities — shared between DynastyForecast and TradeCalculator.
 * Loads model-cache-ktc-v2.json and runs GBM inference on KTC price features.
 */

// ── Types ────────────────────────────────────────────────────────────

interface TreeNode {
  featureIndex: number;
  threshold: number;
  value: number;
  left: TreeNode | null;
  right: TreeNode | null;
}

interface GBMModel {
  trees: TreeNode[];
  initialPrediction: number;
  learningRate: number;
  featureNames: string[];
}

export interface KTCTimeSeriesModel {
  position: string;
  horizon: number;
  gbmModel: GBMModel;
  featureNames: string[];
  n: number;
  yMean: number;
  yStd: number;
  cvResidualStd: number | null;
  cvR2: number | null;
  cvMae: number | null;
  cvScheme: string;
}

export interface ModelCache {
  metadata: {
    schemaVersion: number;
    horizons: number[];
    positions: string[];
    warmupDays: number;
  };
  models: Record<string, KTCTimeSeriesModel>;
}

export interface ForecastResult {
  horizon: number;
  value: number;
  logReturn: number;
  ciLow: number;
  ciHigh: number;
}

// ── Singleton cache loader ───────────────────────────────────────────

let _cachePromise: Promise<ModelCache | null> | null = null;

export function loadModelCache(): Promise<ModelCache | null> {
  if (!_cachePromise) {
    _cachePromise = fetch(`${import.meta.env.BASE_URL}data/model-cache-ktc-v2.json`)
      .then(r => r.ok ? r.json() as Promise<ModelCache> : null)
      .catch(() => null);
  }
  return _cachePromise;
}

// ── GBM prediction ──────────────────────────────────────────────────

function predictTree(node: TreeNode, sample: number[]): number {
  if (node.featureIndex === -1) return node.value;
  if (sample[node.featureIndex] <= node.threshold) {
    return predictTree(node.left!, sample);
  }
  return predictTree(node.right!, sample);
}

export function predictGBM(model: GBMModel, featureVec: number[]): number {
  let pred = model.initialPrediction;
  for (const tree of model.trees) {
    pred += model.learningRate * predictTree(tree, featureVec);
  }
  return pred;
}

// ── Fast feature computation ─────────────────────────────────────────

const WARMUP_DAYS = 30;
const SEASON_START = new Date('2025-09-04');
const REG_SEASON_END = new Date('2026-01-04');
const PLAYOFFS_END = new Date('2026-02-08');

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

const FAST_NAMES = [
  'logValue', 'return_1d', 'return_7d', 'return_14d', 'return_30d',
  'zscore_30d', 'vol_30d', 'drawdown_30d',
  'days_since_max_30d', 'days_since_min_30d',
  'posRankPct', 'posRankPctDelta_7d',
  'daysSinceSeasonStart', 'phaseRegSeason', 'phasePlayoffs', 'phaseOffseason',
];

/** Forward-fill KTC value history to daily cadence. */
export function toDailyTimeSeries(history: { d: string; v: number }[]): { dates: Date[]; vals: number[] } {
  if (history.length === 0) return { dates: [], vals: [] };
  const byD = new Map<string, number>();
  for (const e of history) byD.set(e.d, e.v);
  const sorted = [...byD.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const startDate = new Date(sorted[0][0] + 'T00:00:00');
  const endDate = new Date(sorted[sorted.length - 1][0] + 'T00:00:00');
  const nDays = daysBetween(startDate, endDate) + 1;

  const dateMap = new Map<number, number>();
  for (const [ds, v] of sorted) {
    dateMap.set(daysBetween(startDate, new Date(ds + 'T00:00:00')), v);
  }

  const dates: Date[] = [];
  const vals: number[] = [];
  let prev = sorted[0][1];
  for (let i = 0; i < nDays; i++) {
    dates.push(new Date(startDate.getTime() + i * 86400000));
    if (dateMap.has(i)) prev = dateMap.get(i)!;
    vals.push(prev);
  }
  return { dates, vals };
}

/** Compute 16 fast features at the latest date. Returns null if insufficient history. */
export function computeFastFeatures(dates: Date[], vals: number[]): number[] | null {
  const n = vals.length;
  if (n < WARMUP_DAYS + 2) return null;

  const i = n - 1;
  const safeVals = vals.map(v => Math.max(v, 1));

  const ret1 = i >= 1 ? vals[i] / safeVals[i - 1] - 1 : 0;
  const ret7 = i >= 7 ? vals[i] / safeVals[i - 7] - 1 : 0;
  const ret14 = i >= 14 ? vals[i] / safeVals[i - 14] - 1 : 0;
  const ret30 = i >= 30 ? vals[i] / safeVals[i - 30] - 1 : 0;

  const wStart = Math.max(0, i - 30);
  const w = vals.slice(wStart, i + 1);
  const mean = w.reduce((a, b) => a + b, 0) / w.length;
  const std = Math.sqrt(w.reduce((s, v) => s + (v - mean) ** 2, 0) / w.length);
  const zscore = std > 0 ? (vals[i] - mean) / std : 0;

  const wRets: number[] = [];
  for (let j = wStart + 1; j <= i; j++) {
    wRets.push(vals[j] / safeVals[j - 1] - 1);
  }
  const vol = wRets.length > 0
    ? Math.sqrt(Math.max(0, wRets.reduce((s, r) => s + r * r, 0) / wRets.length - (wRets.reduce((a, b) => a + b, 0) / wRets.length) ** 2))
    : 0;

  const wMax = Math.max(...w);
  const wMin = Math.min(...w);
  const drawdown = wMax > 0 ? (vals[i] - wMax) / wMax : 0;
  const daysSinceMax = w.length - 1 - w.lastIndexOf(wMax);
  const daysSinceMin = w.length - 1 - w.lastIndexOf(wMin);

  const d = dates[i];
  const daysSinceSeasonStart = daysBetween(SEASON_START, d);
  const phaseReg = d >= SEASON_START && d <= REG_SEASON_END ? 1 : 0;
  const phasePlayoffs = d > REG_SEASON_END && d <= PLAYOFFS_END ? 1 : 0;
  const phaseOff = d > PLAYOFFS_END ? 1 : 0;

  return [
    Math.log(Math.max(vals[i], 1)),
    ret1, ret7, ret14, ret30,
    zscore, vol, drawdown,
    daysSinceMax, daysSinceMin,
    0, 0, // posRankPct, posRankPctDelta_7d — filled by caller
    daysSinceSeasonStart, phaseReg, phasePlayoffs, phaseOff,
  ];
}

/** Build full feature vector for a model from fast features. Unknown features → 0. */
export function buildFeatureVec(
  featureNames: string[],
  fastFeats: number[],
  posRankPct: number,
): number[] {
  const fastMap = new Map<string, number>();
  for (let i = 0; i < FAST_NAMES.length; i++) {
    fastMap.set(FAST_NAMES[i], fastFeats[i]);
  }
  fastMap.set('posRankPct', posRankPct);
  return featureNames.map(name => fastMap.get(name) ?? 0);
}

/** Run forecast for a player at all available horizons. */
export function forecastPlayer(
  cache: ModelCache,
  position: string,
  currentValue: number,
  history: { d: string; v: number }[],
  posRankPct: number,
): ForecastResult[] {
  const daily = toDailyTimeSeries(history);
  const fast = computeFastFeatures(daily.dates, daily.vals);
  if (!fast) return [];

  const results: ForecastResult[] = [];
  for (const H of cache.metadata.horizons) {
    const key = `${position}_H${H}`;
    const model = cache.models[key];
    if (!model) continue;

    const vec = buildFeatureVec(model.featureNames, fast, posRankPct);
    const logReturn = predictGBM(model.gbmModel, vec);
    const value = currentValue * Math.exp(logReturn);
    const residStd = model.cvResidualStd ?? model.yStd;
    const ciLow = currentValue * Math.exp(logReturn - 1.96 * residStd);
    const ciHigh = currentValue * Math.exp(logReturn + 1.96 * residStd);

    results.push({ horizon: H, value, logReturn, ciLow, ciHigh });
  }
  return results;
}
