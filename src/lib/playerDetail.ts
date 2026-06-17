import { normalizeName } from './featureTypes';
import type { CrosswalkRec } from './playerLookup';
import type { DynastyPlayer, DynastyPlayerHistory, PlayerStats } from '../types';
import { fetchDynastyRankingsForDisplay, fetchDynastyHistoryForDisplay, fetchPlayerStats, fetchMaybeGz } from '../data';

export interface CareerPrediction {
  name: string;
  position: string;
  school?: string;
  projRound?: number;
  projPick?: number;
  predictedCareerPPG: number;
  combinedScore?: number;
  modelTier?: string;
  percentile?: number;
  boomProb?: number;
  bustProb?: number;
  boomZ?: number;
  bustZ?: number;
  thresholdProbs?: Record<string, number>;
  features?: Record<string, number>;
  draftSeason?: number;    // present on backtest rows
  actualPPG?: number;      // present on backtest rows
}

export interface AdpSeasonRow {
  season: number;
  adp: number;
  adpRound?: number;
  nflDraftRound?: number;
  nflDraftPick?: number;
  age?: number;
  yearsInLeague?: number;
}

/** One feature driving a model's score (see scripts/build-model-eval.mjs). */
export interface ModelDriver {
  feature: string;
  category: string;
  band: string;
  pctile: number;
  relationship: string;
  value?: number;
}

/** A single model that scores the player, with its top feature drivers. */
export interface PlayerModel {
  id: string;
  label: string;
  blurb?: string;
  prediction?: Record<string, number | string>;
  drivers?: ModelDriver[];
  noteOnly?: boolean;
}

export interface PlayerModelDrivers {
  models: PlayerModel[];
  dataGaps?: string[];
}

export interface PlayerDetailData {
  crosswalk: CrosswalkRec;
  career: CareerPrediction | null;
  dynastyCurrent: DynastyPlayer | null;
  dynastyHistory: DynastyPlayerHistory | null;
  adpHistory: AdpSeasonRow[];
  modelDrivers: PlayerModelDrivers | null;
  gameLog: PlayerStats[];
  gameLogSeason: number | null;
}

// Mirror the player keying in scripts/build-model-eval.mjs (lowercase, strip
// every non-alphanumeric incl. spaces) so the card resolves the same record.
const modelEvalKey = (name: string, pos: string) =>
  `${String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '')}|${pos}`;

/**
 * Per-model feature drivers for one player (model-eval-<season>.json). Covers
 * the 2026 scored skill-position pool; null for everyone else.
 */
async function loadModelDrivers(rec: CrosswalkRec): Promise<PlayerModelDrivers | null> {
  try {
    const resp = await fetch(`${import.meta.env.BASE_URL}data/model-eval-2026.json`);
    if (!resp.ok) return null;
    const doc = (await resp.json()) as {
      players?: Array<{ name: string; position: string; models?: PlayerModel[]; dataGaps?: string[] }>;
    };
    const players = doc.players || [];
    // Prefer an exact name+position match; fall back to any of the player's
    // listed positions, then to a name-only match (handles position drift).
    const positions = [rec.position, ...(rec.all_positions || [])].filter(Boolean);
    const hit =
      players.find((p) => positions.some((pos) => modelEvalKey(p.name, p.position) === modelEvalKey(rec.display_name, pos)))
      ?? players.find((p) => p.name.toLowerCase().replace(/[^a-z0-9]/g, '') === rec.display_name.toLowerCase().replace(/[^a-z0-9]/g, ''));
    if (!hit || !hit.models?.length) return null;
    return { models: hit.models, dataGaps: hit.dataGaps };
  } catch {
    return null;
  }
}

async function loadCareer(rec: CrosswalkRec): Promise<CareerPrediction | null> {
  // 2026 rookies: feature-matrix.json has `player_key` already stamped.
  try {
    const resp = await fetchMaybeGz(`${import.meta.env.BASE_URL}data/feature-matrix.json`);
    if (resp.ok) {
      const doc = (await resp.json()) as { careerPredictions2026?: Array<CareerPrediction & { player_key?: string }> };
      const hit = (doc.careerPredictions2026 || []).find((p) => p.player_key === rec.player_key);
      if (hit) return hit;
    }
  } catch {
    // fetch/parse failure is non-fatal — fall through to the backtest cache.
  }
  // Historical players: scan backtestRows from the career model cache.
  // Backtest rows don't carry player_key — match on normalized name +
  // position. The crosswalk guarantees uniqueness for in-league
  // players by virtue of their gsis-based key.
  try {
    const resp = await fetch(`${import.meta.env.BASE_URL}data/model-cache-career-v72.json`);
    if (!resp.ok) return null;
    const doc = (await resp.json()) as { rookieCareerModels?: Record<string, { backtestRows?: Array<CareerPrediction & { name: string; position: string }> }> };
    const models = doc.rookieCareerModels || {};
    const normTarget = normalizeName(rec.display_name);
    for (const [, m] of Object.entries(models)) {
      const hit = (m.backtestRows || []).find(
        (r) => normalizeName(r.name) === normTarget && r.position === rec.position,
      );
      if (hit) return hit;
    }
  } catch {
    // Cache miss is fine — there just isn't a trained model for this player.
  }
  return null;
}

async function loadDynasty(rec: CrosswalkRec): Promise<{ current: DynastyPlayer | null; history: DynastyPlayerHistory | null }> {
  if (!rec.ktc_id) return { current: null, history: null };
  try {
    const rankings = await fetchDynastyRankingsForDisplay('1qb');
    const current = rankings.find((p) => p.playerID === rec.ktc_id) || null;
    const positionByID = new Map<number, string>();
    if (current) positionByID.set(current.playerID, current.position);
    const history = await fetchDynastyHistoryForDisplay([rec.ktc_id], positionByID);
    const hist = history.find((h) => h.playerID === rec.ktc_id) || null;
    return { current, history: hist };
  } catch {
    return { current: null, history: null };
  }
}

async function loadAdpHistory(rec: CrosswalkRec): Promise<AdpSeasonRow[]> {
  try {
    const [profileResp, playersResp] = await Promise.all([
      fetch(`${import.meta.env.BASE_URL}data/feature-store/profile.json`),
      fetch(`${import.meta.env.BASE_URL}data/feature-store/players.json`),
    ]);
    if (!profileResp.ok || !playersResp.ok) return [];
    const profile = (await profileResp.json()) as Record<string, Record<string, number>>;
    const players = (await playersResp.json()) as Record<string, { displayName?: string; position?: string }>;
    // Key shape: `${normalized_name}::${season}`. We match on our
    // crosswalk record's normalized display_name + position.
    const normTarget = normalizeName(rec.display_name);
    const rows: AdpSeasonRow[] = [];
    for (const [key, vals] of Object.entries(profile)) {
      const idx = key.lastIndexOf('::');
      if (idx < 0) continue;
      const nm = key.slice(0, idx);
      const season = Number(key.slice(idx + 2));
      if (!season || normalizeName(nm) !== normTarget) continue;
      const meta = players[key];
      if (meta?.position && meta.position !== rec.position && !(rec.all_positions || []).includes(meta.position)) continue;
      rows.push({
        season,
        adp: Number(vals.adp) || 0,
        adpRound: vals.adpRound,
        nflDraftRound: vals.nflDraftRound,
        nflDraftPick: vals.nflDraftPick,
        age: vals.age,
        yearsInLeague: vals.yearsInLeague,
      });
    }
    rows.sort((a, b) => a.season - b.season);
    return rows;
  } catch {
    return [];
  }
}

async function loadGameLog(rec: CrosswalkRec): Promise<{ rows: PlayerStats[]; season: number | null }> {
  if (!rec.gsis_id || !rec.latest_season) return { rows: [], season: null };
  try {
    const rows = await fetchPlayerStats(rec.latest_season);
    const mine = rows.filter((r) => r.player_id === rec.gsis_id);
    mine.sort((a, b) => a.week - b.week);
    return { rows: mine, season: rec.latest_season };
  } catch {
    return { rows: [], season: null };
  }
}

export async function loadPlayerDetail(rec: CrosswalkRec): Promise<PlayerDetailData> {
  const [career, dynasty, adpHistory, modelDrivers, gameLog] = await Promise.all([
    loadCareer(rec),
    loadDynasty(rec),
    loadAdpHistory(rec),
    loadModelDrivers(rec),
    loadGameLog(rec),
  ]);
  return {
    crosswalk: rec,
    career,
    dynastyCurrent: dynasty.current,
    dynastyHistory: dynasty.history,
    adpHistory,
    modelDrivers,
    gameLog: gameLog.rows,
    gameLogSeason: gameLog.season,
  };
}
