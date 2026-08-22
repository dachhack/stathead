/**
 * Browser-side model score client.
 * Loads per-model score shards from the build output.
 * All pages use this for consistent scores.
 */

import type { CareerScore, ADPScore, PPGScore, ScoreManifest } from './modelScoreStore';
import { canonicalizePlayerName } from './combineNameAliases';
import { normalizeNameUnicode } from './nameMatch';

const cache = new Map<string, any>();

function storeUrl(): string {
  const base = typeof import.meta !== 'undefined' ? import.meta.env?.BASE_URL || '/' : '/';
  return `${base}data/score-store`;
}

async function loadShard<T>(name: string): Promise<T[]> {
  if (cache.has(name)) return cache.get(name);
  try {
    const resp = await fetch(`${storeUrl()}/${name}.json`);
    if (!resp.ok) return [];
    const data = await resp.json();
    cache.set(name, data);
    return data;
  } catch {
    return [];
  }
}

/** Load all career scores (backtest + 2026 prospects) */
export async function loadCareerScores(): Promise<CareerScore[]> {
  return loadShard<CareerScore>('career');
}

/** Load ADP hit/bust predictions (2026) */
export async function loadADPScores(): Promise<ADPScore[]> {
  return loadShard<ADPScore>('adp');
}

/** Load ADP-free PPG predictions (2026) */
export async function loadPPGScores(): Promise<PPGScore[]> {
  return loadShard<PPGScore>('ppg');
}

/** Load score store manifest */
export async function loadScoreManifest(): Promise<ScoreManifest | null> {
  try {
    const resp = await fetch(`${storeUrl()}/manifest.json`);
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

/** Get career scores filtered by draft class */
export async function getCareerScoresByClass(draftSeason: number): Promise<CareerScore[]> {
  const all = await loadCareerScores();
  return all.filter(s => s.draftSeason === draftSeason);
}

/** Get career scores filtered by position */
export async function getCareerScoresByPosition(position: string): Promise<CareerScore[]> {
  const all = await loadCareerScores();
  return all.filter(s => s.position === position);
}

/** Get a single player's career score */
export async function getPlayerCareerScore(name: string, position: string): Promise<CareerScore | undefined> {
  const norm = (s: string) => s.toLowerCase().replace(/[.']/g, '').replace(/\s+(jr|sr|ii|iii|iv|v)$/i, '').replace(/\s+/g, ' ').trim();
  const all = await loadCareerScores();
  const nn = norm(name);
  return all.find(s => norm(s.name) === nn && s.position === position);
}

/**
 * Career-model outputs for one prospect, in the shape the prospect boards
 * render. Mirrors the fields `careerPredictions2026` carries in
 * feature-matrix.json so either source can populate a row.
 */
export interface CareerModelScore {
  ppg: number;
  combinedScore: number;
  percentile: number;
  modelTier: number;
  boomProb: number;
  bustProb: number;
  boomZ?: number;
  bustZ?: number;
  thresholdProbs: Record<number, number>;
  features?: Record<string, number>;
}

/**
 * Career model scores for one draft class, keyed the way the prospect views
 * key their rows (alias-canonicalized, then unicode-normalized), plus the
 * per-position PPG thresholds the tier-probability columns index by.
 *
 * This reads the purpose-built score-store shard (~7 MiB) rather than the
 * 25 MiB feature-matrix.json the boards used to depend on for the same
 * numbers, so a failure to load that one big file no longer blanks every
 * model column. The shard is the canonical published score source (see
 * modelScoreStore's header) and is written by the same build pass, so the
 * values agree.
 */
export async function loadCareerScoreIndex(draftSeason: number): Promise<{
  byName: Map<string, CareerModelScore>;
  posThresholds: Record<string, number[]>;
}> {
  const scores = await loadCareerScores();
  const byName = new Map<string, CareerModelScore>();
  const posThresholds: Record<string, number[]> = {};
  for (const s of scores) {
    if (s.draftSeason !== draftSeason) continue;
    byName.set(normalizeNameUnicode(canonicalizePlayerName(s.name)), {
      ppg: s.predictedPPG || 0,
      // The store publishes one percentile; the boards' "combined score" is
      // the same number under its older name.
      combinedScore: s.percentile || 0,
      percentile: s.percentile || 0,
      modelTier: s.tier || 0,
      boomProb: s.boomProb || 0,
      bustProb: s.bustProb || 0,
      boomZ: s.boomZ,
      bustZ: s.bustZ,
      thresholdProbs: s.thresholdProbs || {},
      features: s.features,
    });
    // Thresholds are the numeric keys of thresholdProbs, ascending — the
    // same [12,14,16,18] (RB/WR), [8,9,10,11] (TE), [16,18,20,22] (QB)
    // ladders the models were trained against.
    if (!posThresholds[s.position]) {
      const ts = Object.keys(s.thresholdProbs || {})
        .map(Number)
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => a - b);
      if (ts.length) posThresholds[s.position] = ts;
    }
  }
  return { byName, posThresholds };
}

/** Clear cached shards */
export function clearScoreCache(): void {
  cache.clear();
}
