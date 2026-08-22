/**
 * Model Score Store — persists per-player model outputs as JSON shards.
 *
 * Each model type writes its outputs (predictions, percentiles, tiers, etc.)
 * to a separate shard file. UI components read from these shards instead of
 * the monolithic feature-matrix.json, ensuring consistent scores across all pages.
 *
 * Shards:
 *   score-store/career.json    — rookie career model (backtest + 2026)
 *   score-store/adp.json       — ADP hit/bust predictions (2026)
 *   score-store/ppg.json       — ADP-free PPG predictions (2026)
 *   score-store/residual.json  — residual/alpha-blended (2026)
 *   score-store/manifest.json  — metadata (model versions, timestamps)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const STORE_DIR = 'public/data/score-store';

// ── Types ─────────────────────────────────────────────────────────

export interface CareerScore {
  name: string;
  position: string;
  draftSeason: number;
  predictedPPG: number;
  actualPPG?: number;      // only for backtest (historical players)
  percentile: number;       // cross-year within position
  tier: number;             // 1-6 (Alpha → Longshot)
  tierLabel: string;
  thresholdProbs: Record<number, number>;
  boomProb?: number;       // P(outperform by > 0.75×MAE), heteroscedastic by prediction tier
  bustProb?: number;       // P(underperform by > 0.75×MAE), heteroscedastic by prediction tier
  boomZ?: number;          // talent-gap boom score, z vs the position's class (Python model)
  bustZ?: number;          // talent-gap bust score, z vs the position's class (Python model)
  features?: Record<string, number>;
  featurePercentiles?: Record<string, number>; // 0-100 cross-year within position
  school?: string;
  projPick?: number;
}

export interface ADPScore {
  name: string;
  position: string;
  team: string;
  adp: number;
  /**
   * MISNOMER (kept for backwards compat): this field is the ADP-aware model's
   * predicted PPG, not VOR. The z-score normalization was baked into the
   * model weights at training time and is NOT re-applied at prediction time.
   * Real "edge over ADP" should be computed against `manifest.adpCurves[pos]`
   * (see `AdpCurve`); see `DraftOptimizerTable` for the canonical use.
   */
  predictedVor: number;
  hitProb: string;
  ciLower: number;
  ciUpper: number;
  isRookie: boolean;
  headshotUrl?: string;
}

export interface PPGScore {
  name: string;
  position: string;
  predictedPPG: number;
}

export interface ShareScore {
  name: string;
  position: string;
  team: string;
  predTargetShare: number;
  predRushShare: number;
}

export interface ResidualScore {
  name: string;
  position: string;
  predictedResidual: number;
  alpha: number;
}

/**
 * Team-volume projection emitted per predRow by the volume pass in
 * buildFeatureMatrix.ts. Mirrors the `mlProj*` features so they can be
 * inspected without loading feature-matrix.json.
 *
 * - `team{Pass,Rush}Att` and `teamTargets` are season-total projected volumes
 *   for the player's team. Vegas is applied on the scoring side only.
 * - `team*{Low,High}` are ±1σ bounds derived from the formula's historical
 *   residual standard deviation across 480 (team, season) pairs (2011–2025
 *   LOSO). Pass σ=12.4%, rush σ=15.3%, tgt σ=12.7%. Not per-team adaptive
 *   yet — every team gets the same proportional bounds.
 * - `projPlayerPPG` is the volume-derived PPG estimate (volume × share ×
 *   efficiency, blended with prior at 60/40 when `priorSnapPct > 30`). Not
 *   the primary PPG surfaced to users (that's `score-store/ppg.json`), but
 *   useful as a cross-check.
 */
export interface VolumeScore {
  name: string;
  position: string;
  team: string;
  teamPassAtt: number;
  teamPassAttLow: number;
  teamPassAttHigh: number;
  teamRushAtt: number;
  teamRushAttLow: number;
  teamRushAttHigh: number;
  teamTargets: number;
  teamTargetsLow: number;
  teamTargetsHigh: number;
  projPlayerPPG: number;
}

/**
 * Per-position ADP→PPG baseline curve. Form:
 * `PPG = sqrtIntercept + sqrtSlope * sqrt(ADP) + poolOffset`.
 *
 * The (sqrtSlope, sqrtIntercept) pair is fit on 2010–2025 historical data —
 * sqrt was chosen empirically over linear/log/inverse/quadratic by LOSO
 * MAE (see audit in train_projection_models.py docstring).
 *
 * `poolOffset` corrects for selection bias between the historical training
 * cohort (which includes ADPed flameouts that never played) and the curated
 * 2026 prediction pool (rosterable players only). Without it, PickEdge
 * skews systematically high — the 2026 pool's prior-year stats are 1.5–3×
 * stronger than historical players at the same ADP, so model predictions
 * land 1.8–4.4 PPG above the historical-mean curve at every position. The
 * offset is computed at build time as the per-position mean of
 * `(predictedPPG − sqrt-only baseline)` across the pool, so it recenters
 * PickEdge to "edge vs typical 2026 draftable at this ADP."
 *
 * The frontend uses the full form (including poolOffset) when computing
 * Pick Edge and Beat %. Sort order is unaffected — the offset is a
 * constant shift per position.
 */
export interface AdpCurve {
  sqrtSlope: number;
  sqrtIntercept: number;
  /** Per-position recentering offset. See interface docstring. */
  poolOffset?: number;
  /** Sample size used to fit (training rows after ADP ≤ 250 filter). */
  n?: number;
}

export interface ScoreManifest {
  version: number;
  updatedAt: string;
  models: {
    career?: { version: string; count: number; backtestCount: number };
    adp?: { version: string; count: number };
    ppg?: { version: string; count: number };
    residual?: { version: string; count: number };
    volumes?: { version: string; count: number };
  };
  /** Per-position ADP→PPG baseline curve. Keys: 'QB' | 'RB' | 'WR' | 'TE'. */
  adpCurves?: Record<string, AdpCurve>;
}

// ── Store API ─────────────────────────────────────────────────────

function ensureDir(): void {
  if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true });
}

export function writeCareerScores(scores: CareerScore[]): void {
  ensureDir();
  writeFileSync(join(STORE_DIR, 'career.json'), JSON.stringify(scores));
}

export function writeADPScores(scores: ADPScore[]): void {
  ensureDir();
  writeFileSync(join(STORE_DIR, 'adp.json'), JSON.stringify(scores));
}

export function writePPGScores(scores: PPGScore[]): void {
  ensureDir();
  writeFileSync(join(STORE_DIR, 'ppg.json'), JSON.stringify(scores));
}

export function writeShareScores(scores: ShareScore[]): void {
  ensureDir();
  writeFileSync(join(STORE_DIR, 'shares.json'), JSON.stringify(scores));
}

export function writeResidualScores(scores: ResidualScore[]): void {
  ensureDir();
  writeFileSync(join(STORE_DIR, 'residual.json'), JSON.stringify(scores));
}

export function writeVolumeScores(scores: VolumeScore[]): void {
  ensureDir();
  writeFileSync(join(STORE_DIR, 'volumes.json'), JSON.stringify(scores));
}

export function writeScoreManifest(manifest: ScoreManifest): void {
  ensureDir();
  writeFileSync(join(STORE_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

// ── Read (for build-time use) ─────────────────────────────────────

export function readCareerScores(): CareerScore[] {
  const path = join(STORE_DIR, 'career.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : [];
}

export function readScoreManifest(): ScoreManifest | null {
  const path = join(STORE_DIR, 'manifest.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : null;
}

// ── Tier helpers ──────────────────────────────────────────────────

const TIER_DEFS = [
  { tier: 1, label: 'Alpha',       pctlMin: 95 },
  { tier: 2, label: 'Blue Chip',   pctlMin: 85 },
  { tier: 3, label: 'Starter',     pctlMin: 70 },
  { tier: 4, label: 'Contributor', pctlMin: 50 },
  { tier: 5, label: 'Depth',       pctlMin: 30 },
  { tier: 6, label: 'Longshot',    pctlMin: 0 },
];

export function tierFromPercentile(pctl: number): { tier: number; label: string } {
  for (const t of TIER_DEFS) {
    if (pctl >= t.pctlMin) return { tier: t.tier, label: t.label };
  }
  return { tier: 6, label: 'Longshot' };
}
