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

export interface ResidualScore {
  name: string;
  position: string;
  predictedResidual: number;
  alpha: number;
}

export interface ScoreManifest {
  version: number;
  updatedAt: string;
  models: {
    career?: { version: string; count: number; backtestCount: number };
    adp?: { version: string; count: number };
    ppg?: { version: string; count: number };
    residual?: { version: string; count: number };
  };
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

export function writeResidualScores(scores: ResidualScore[]): void {
  ensureDir();
  writeFileSync(join(STORE_DIR, 'residual.json'), JSON.stringify(scores));
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
