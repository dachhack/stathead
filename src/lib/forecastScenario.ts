/**
 * Scenario explorer for the dynasty value forecast: rerun the shipped
 * per-(position, horizon) GBMs in the browser with one or more of a player's
 * in-season metrics changed, and see how each horizon's forecast moves.
 *
 * Inputs (both written by scripts/train_ktc_timeseries.py):
 *   dynasty-forecast-features.json  every player's feature vector, by name,
 *                                   as of the forecast date
 *   model-cache-dynasty-v2.json     the models (trees serialized for
 *                                   src/lib/gbm.ts) with their shrinkage and
 *                                   residual std
 *
 * The models output a log-return, which is scale-invariant, so a scenario
 * value is simply the displayed (StatHead-scale) current value × exp(return):
 * nothing here touches a market's raw numbers.
 */

import { predictGBM, type TrainedGBM } from './gbm';

// ── Types ────────────────────────────────────────────────────────────

export interface PlayerFeatureVector {
  name: string;
  position: string;
  asOf: string;
  features: Record<string, number>;
}

export interface ForecastFeatureFile {
  generatedAt: string;
  horizons: number[];
  featureNames: Record<string, string[]>;
  fastFeatureNames: string[];
  weeklyFeatureNames: string[];
  players: Record<string, PlayerFeatureVector>;
}

export interface ForecastModel {
  position: string;
  horizon: number;
  gbmModel: TrainedGBM;
  featureNames: string[];
  forecastDampen?: number;
  inSampleR2: number;
  cvR2PlayerGrouped: number | null;
  cvResidualStd: number | null;
  yStd: number;
}

export interface ForecastModelFile {
  metadata: { horizons: number[] };
  models: Record<string, ForecastModel>;
}

export interface ScenarioHorizon {
  horizon: number;
  logReturn: number;      // after shrinkage, as published
  rawLogReturn: number;   // the model's own output
  residStd: number;
  dampen: number;
  contributions: { name: string; value: number; contribution: number }[];
}

// ── Loaders (singletons; the model cache is ~3 MB so load it lazily) ─

let _features: Promise<ForecastFeatureFile | null> | null = null;
let _models: Promise<ForecastModelFile | null> | null = null;

export function loadForecastFeatures(): Promise<ForecastFeatureFile | null> {
  if (!_features) {
    _features = fetch(`${import.meta.env.BASE_URL}data/dynasty-forecast-features.json`)
      .then(r => r.ok ? r.json() as Promise<ForecastFeatureFile> : null)
      .catch(() => null);
  }
  return _features;
}

export function loadForecastModels(): Promise<ForecastModelFile | null> {
  if (!_models) {
    _models = fetch(`${import.meta.env.BASE_URL}data/model-cache-dynasty-v2.json`)
      .then(r => r.ok ? r.json() as Promise<ForecastModelFile> : null)
      .catch(() => null);
  }
  return _models;
}

// ── The adjustable in-season metrics ─────────────────────────────────
//
// Each slider edits one stored feature; `derived` lists the trend features
// the trainer computes from it (last 4 games minus season to date), which
// are recomputed so a scenario stays internally consistent.

export interface ScenarioMetric {
  key: string;
  label: string;
  group: 'Snaps' | 'Targets' | 'Carries' | 'Production' | 'Availability' | 'Depth chart';
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  hint?: string;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const num = (d = 0) => (v: number) => v.toFixed(d);

export const SCENARIO_METRICS: ScenarioMetric[] = [
  { key: 'snapPctLast4', label: 'Snap share, last 4 games', group: 'Snaps', min: 0, max: 1, step: 0.01, format: pct },
  { key: 'snapPctSeason', label: 'Snap share, season', group: 'Snaps', min: 0, max: 1, step: 0.01, format: pct },
  { key: 'targetsLast4', label: 'Targets per game, last 4', group: 'Targets', min: 0, max: 16, step: 0.5, format: num(1) },
  { key: 'targetsSeason', label: 'Targets per game, season', group: 'Targets', min: 0, max: 16, step: 0.5, format: num(1) },
  { key: 'carriesLast4', label: 'Carries per game, last 4', group: 'Carries', min: 0, max: 30, step: 0.5, format: num(1) },
  { key: 'carriesSeason', label: 'Carries per game, season', group: 'Carries', min: 0, max: 30, step: 0.5, format: num(1) },
  { key: 'rushRecYardsLast4', label: 'Rush + rec yards per game, last 4', group: 'Production', min: 0, max: 200, step: 5, format: num(0) },
  // Floor at 1: zero games reads to the models as "season not started", a
  // different regime, not a player who has missed every game.
  { key: 'gamesPlayedSeason', label: 'Games played this season', group: 'Availability', min: 1, max: 18, step: 1, format: num(0) },
  { key: 'weeksSinceLastPlayed', label: 'Weeks since he last played', group: 'Availability', min: 0, max: 10, step: 1, format: num(0),
    hint: '0 = played the latest week; 10 = out all season' },
  { key: 'injuryOut2wk', label: 'Out / IR / Doubtful weeks, last 2', group: 'Availability', min: 0, max: 2, step: 1, format: num(0) },
  { key: 'depthRankLatest', label: 'Depth chart rank', group: 'Depth chart', min: 1, max: 5, step: 1, format: num(0),
    hint: '1 = starter' },
];

const DERIVED: Record<string, [string, string]> = {
  // trend = last 4 − season
  snapPctTrend: ['snapPctLast4', 'snapPctSeason'],
  targetsTrend: ['targetsLast4', 'targetsSeason'],
  carriesTrend: ['carriesLast4', 'carriesSeason'],
};

/** The feature vector with the scenario's overrides applied and the derived trends recomputed. */
export function applyScenario(
  base: Record<string, number>,
  overrides: Record<string, number>,
): Record<string, number> {
  const out = { ...base, ...overrides };
  for (const [trend, [a, b]] of Object.entries(DERIVED)) {
    if (a in out && b in out) out[trend] = out[a] - out[b];
  }
  return out;
}

/** Plain-English names for the features the explorer surfaces. */
export const FEATURE_LABELS: Record<string, string> = {
  logValue: 'Current value (log)',
  return_1d: '1-day value change', return_7d: '7-day value change',
  return_14d: '14-day value change', return_30d: '30-day value change',
  zscore_30d: 'Value vs 30-day average', vol_30d: '30-day volatility',
  drawdown_30d: 'Drop from 30-day high',
  days_since_max_30d: 'Days since 30-day high', days_since_min_30d: 'Days since 30-day low',
  posRankPct: 'Rank within position', posRankPctDelta_7d: '7-day rank change',
  daysSinceSeasonStart: 'Days into the season',
  phaseRegSeason: 'Regular season', phasePlayoffs: 'Playoffs', phaseOffseason: 'Offseason',
  age: 'Age', yearsInLeague: 'Years in league',
  nflDraftRound: 'Draft round', nflDraftPick: 'Draft pick', invDraftPick: 'Draft pick (inverse)',
  logDraftPick: 'Draft pick (log)', draftPickPctOverall: 'Draft pick percentile',
  priorPPG: 'Prior-season PPG', priorPPG2yr: 'Two-year PPG', priorGames: 'Prior-season games',
  priorSnapPct: 'Prior-season snap share', priorTargetShare: 'Prior-season target share',
  ppgTrend: 'PPG trend', depthChartRank: 'Depth rank (prior)',
  qbOwnPPG: "Team QB's PPG", bmi: 'BMI', weight: 'Weight', forty: '40 time', speedScore: 'Speed score',
  projPlayerPPR: 'Projected PPR', projTargetShare: 'Projected target share',
  priorInjuryWeeks: 'Prior-season weeks injured',
  snapPctLast4: 'Snap share, last 4', snapPctSeason: 'Snap share, season', snapPctTrend: 'Snap share trend',
  targetsLast4: 'Targets, last 4', targetsSeason: 'Targets, season', targetsTrend: 'Target trend',
  carriesLast4: 'Carries, last 4', carriesSeason: 'Carries, season', carriesTrend: 'Carry trend',
  rushRecYardsLast4: 'Yards per game, last 4', recEpaLast4: 'Receiving EPA, last 4', rushEpaLast4: 'Rushing EPA, last 4',
  gamesPlayedSeason: 'Games played', weeksSinceLastPlayed: 'Weeks since last played',
  injuryOut2wk: 'Out / IR weeks, last 2', depthRankLatest: 'Depth chart rank', depthRankDelta14d: 'Depth chart move',
};

export function featureLabel(name: string): string {
  return FEATURE_LABELS[name] ?? name;
}

// ── Running the models ───────────────────────────────────────────────

/** Mirrors scripts/train_ktc_timeseries.py::forecast_dampen. */
export function dampenFor(m: ForecastModel): number {
  if (m.forecastDampen != null) return m.forecastDampen;
  const pg = m.cvR2PlayerGrouped;
  if (m.inSampleR2 > 0 && pg != null && pg > 0) return Math.min(1, Math.max(0.1, pg / m.inSampleR2));
  return 0.1;
}

/**
 * Run every horizon's model for one position on a feature vector. Returns
 * the published-style (shrunk) log-return per horizon, plus the features
 * that moved each prediction most.
 */
export function runScenario(
  models: ForecastModelFile,
  position: string,
  features: Record<string, number>,
  horizons: number[],
): ScenarioHorizon[] {
  const out: ScenarioHorizon[] = [];
  for (const h of horizons) {
    const m = models.models[`${position}_H${h}`];
    if (!m) continue;
    // The serialized model carries featureNames at the top level; predictGBM
    // reads them off the GBM, so make sure it has them.
    const gbm: TrainedGBM = { ...m.gbmModel, featureNames: m.gbmModel.featureNames ?? m.featureNames };
    const pred = predictGBM(gbm, features);
    const dampen = dampenFor(m);
    out.push({
      horizon: h,
      rawLogReturn: pred.predicted,
      logReturn: pred.predicted * dampen,
      residStd: m.cvResidualStd ?? m.yStd ?? 0.1,
      dampen,
      contributions: pred.featureContributions,
    });
  }
  return out;
}

/** A scenario horizon as a displayed value with its 95% band, from the displayed current value. */
export function scenarioValue(current: number, s: ScenarioHorizon) {
  return {
    value: Math.round(current * Math.exp(s.logReturn)),
    ciLow: Math.round(current * Math.exp(s.logReturn - 1.96 * s.residStd)),
    ciHigh: Math.round(current * Math.exp(s.logReturn + 1.96 * s.residStd)),
  };
}
