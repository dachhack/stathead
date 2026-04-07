/**
 * Browser-side model score client.
 * Loads per-model score shards from the build output.
 * All pages use this for consistent scores.
 */

import type { CareerScore, ADPScore, PPGScore, ScoreManifest } from './modelScoreStore';

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

/** Clear cached shards */
export function clearScoreCache(): void {
  cache.clear();
}
