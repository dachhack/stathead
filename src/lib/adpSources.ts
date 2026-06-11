/**
 * Multi-source redraft ADP — load, join, and blend every ADP source the
 * repo tracks. Two regimes with different jobs:
 *
 * HISTORIC ADP (seasons before the current one) — immutable committed
 * snapshots, fetched once and never refreshed. This is the model-training
 * and research input, so `loadHistoricAdpSources` reads ONLY the committed
 * files (no live-API fallback): a backtest must see the same numbers every
 * run. The Node-side training pipeline (buildFeatureMatrix) gets the same
 * determinism via readLocalFile on the same snapshots.
 *
 * CURRENT ADP (the upcoming draft season) — refreshed daily by CI or
 * fetched live. This is the input for scoring models, projections, and
 * draft optimization, where freshness beats reproducibility.
 *
 * Sources:
 *  - FFC (FantasyFootballCalculator mock drafts) — committed snapshots
 *    2018+ (`ffc_adp_ppr_<season>.json`); current season re-fetched daily
 *    by fetch-ffc-adp.yml.
 *  - Sleeper draft rooms — committed snapshots 2020+
 *    (`sleeper-adp-<season>.json`); current season re-fetched daily by
 *    fetch-sleeper-players.yml. Sleeper has no ADP before 2020.
 *  - ESPN drafts — live undocumented v3 API, current season only here.
 *  - FantasyCalc — consensus from real leagues; real ADP when populated,
 *    else the overall value rank as a pick proxy. Current season only
 *    (the daily snapshot has no history).
 *
 * The blend is the mean pick across available sources — the standard
 * "consensus ADP" aggregation; all sources are overall pick numbers on
 * the same scale. The spread (max − min) is the disagreement signal.
 */

import { fetchFfcADP, fetchEspnADP, fetchFantasyCalcValues } from '../data';
import { normName } from './nameUtils';

export type AdpSourceKey = 'ffc' | 'sleeper' | 'espn' | 'fc';

export const ADP_SOURCE_LABELS: Record<AdpSourceKey, string> = {
  ffc: 'FFC',
  sleeper: 'Sleeper',
  espn: 'ESPN',
  fc: 'FantasyCalc',
};

export const ADP_SOURCE_TITLES: Record<AdpSourceKey, string> = {
  ffc: 'FantasyFootballCalculator mock-draft ADP (PPR)',
  sleeper: 'Sleeper draft-room ADP (PPR)',
  espn: 'ESPN live-draft ADP',
  fc: 'FantasyCalc — real ADP when populated, else consensus value rank as a pick proxy',
};

export interface MultiAdpRow {
  name: string;
  position: string;
  team: string;
  sleeperId?: string;
  adp: Partial<Record<AdpSourceKey, number>>;
  /** Mean pick across available sources. */
  blend: number;
  /** max − min across sources; 0 with fewer than 2 sources. */
  spread: number;
  sourceCount: number;
}

interface RawEntry {
  name: string;
  position: string;
  team?: string;
  adp: number;
  sleeperId?: string;
}

// Canonicalize team codes across sources (nflverse-style, as used app-wide).
const TEAM_CANON: Record<string, string> = { LAR: 'LA', WSH: 'WAS', JAC: 'JAX', AZ: 'ARI', ARZ: 'ARI' };
const canonTeam = (t?: string | null): string => (t ? TEAM_CANON[t] ?? t : '');

const SKILL = new Set(['QB', 'RB', 'WR', 'TE']);
const BASE = import.meta.env.BASE_URL;

interface SleeperAdpDoc {
  season: number;
  players: Array<{
    sleeper_id?: string; name: string; position: string; team?: string;
    adp_ppr?: number; adp_half_ppr?: number; adp_std?: number;
  }>;
}

async function loadSleeper(season: number): Promise<RawEntry[]> {
  try {
    const r = await fetch(`${BASE}data/sleeper-adp-${season}.json`);
    if (!r.ok) return [];
    const doc = (await r.json()) as SleeperAdpDoc;
    return (doc.players ?? [])
      .map((p) => ({
        name: p.name,
        position: p.position,
        team: canonTeam(p.team),
        adp: p.adp_ppr ?? p.adp_half_ppr ?? p.adp_std ?? 0,
        sleeperId: p.sleeper_id,
      }))
      .filter((p) => p.adp > 0);
  } catch {
    return [];
  }
}

async function loadFfc(season: number): Promise<RawEntry[]> {
  try {
    const players = await fetchFfcADP(season, 'ppr', 12);
    return players
      .filter((p) => SKILL.has(p.position) && p.adp > 0)
      .map((p) => ({ name: p.name, position: p.position, team: canonTeam(p.team), adp: p.adp }));
  } catch {
    return [];
  }
}

// Snapshot-only FFC for historic seasons — reads the committed per-season
// file directly, with no live-API fallback, so research is deterministic.
async function loadFfcSnapshot(season: number): Promise<RawEntry[]> {
  try {
    const r = await fetch(`${BASE}data/ffc_adp_ppr_${season}.json`);
    if (!r.ok) return [];
    const doc = (await r.json()) as { players?: Array<{ name: string; position: string; team?: string; adp: number }> };
    return (doc.players ?? [])
      .filter((p) => SKILL.has(p.position) && Number(p.adp) > 0)
      .map((p) => ({ name: p.name, position: p.position, team: canonTeam(p.team), adp: Number(p.adp) }));
  } catch {
    return [];
  }
}

async function loadEspn(season: number): Promise<RawEntry[]> {
  try {
    const players = await fetchEspnADP(season);
    return players
      .filter((p) => SKILL.has(p.position) && p.adp > 0)
      .map((p) => ({ name: p.name, position: p.position, team: canonTeam(p.team), adp: p.adp }));
  } catch {
    return [];
  }
}

async function loadFc(): Promise<RawEntry[]> {
  try {
    const players = await fetchFantasyCalcValues(false, 1, 12, 1);
    return players
      .filter((p) => SKILL.has(p.player.position))
      .map((p) => ({
        name: p.player.name,
        position: p.player.position,
        team: canonTeam(p.player.maybeTeam),
        adp: p.maybeAdp != null && p.maybeAdp > 0 ? p.maybeAdp : p.overallRank,
        sleeperId: p.player.sleeperId,
      }));
  } catch {
    return [];
  }
}

export interface AdpSourceData {
  season: number;
  sources: Record<AdpSourceKey, RawEntry[]>;
}

/** Historic regime: committed snapshots only (FFC + Sleeper), no live
 *  calls — same numbers on every run. The research/training input. */
export async function loadHistoricAdpSources(season: number): Promise<AdpSourceData> {
  const [ffc, sleeper] = await Promise.all([loadFfcSnapshot(season), loadSleeper(season)]);
  return { season, sources: { ffc, sleeper, espn: [], fc: [] } };
}

/** Current regime: every live + daily-refreshed source. The input for
 *  scoring, projections, and draft optimization. */
export async function loadCurrentAdpSources(season: number): Promise<AdpSourceData> {
  const [ffc, sleeper, espn, fc] = await Promise.all([
    loadFfc(season),
    loadSleeper(season),
    loadEspn(season),
    loadFc(),
  ]);
  return { season, sources: { ffc, sleeper, espn, fc } };
}

/** Route to the right regime for the requested season. */
export async function loadAdpSources(season: number, currentSeason: number): Promise<AdpSourceData> {
  return season < currentSeason ? loadHistoricAdpSources(season) : loadCurrentAdpSources(season);
}

const round1 = (v: number): number => Math.round(v * 10) / 10;

/** Mean of the available real-market picks — the blend the scoring
 *  surfaces (My Rankings, Draft Kit) put on a player. Ignores missing /
 *  sentinel (≥999) values; undefined when no market prices the player. */
export function blendPicks(...picks: Array<number | undefined>): number | undefined {
  const vals = picks.filter((v): v is number => v !== undefined && Number.isFinite(v) && v > 0 && v < 999);
  if (!vals.length) return undefined;
  return round1(vals.reduce((a, b) => a + b, 0) / vals.length);
}

/** Join the sources by player and compute the blend + disagreement spread. */
export function buildMultiAdpRows(data: AdpSourceData): MultiAdpRow[] {
  const byName = new Map<string, MultiAdpRow>();
  for (const key of Object.keys(data.sources) as AdpSourceKey[]) {
    for (const e of data.sources[key]) {
      const nn = normName(e.name);
      if (!nn) continue;
      let row = byName.get(nn);
      if (!row) {
        row = { name: e.name, position: e.position, team: '', adp: {}, blend: 0, spread: 0, sourceCount: 0 };
        byName.set(nn, row);
      }
      // First source to provide a team/id wins (source order is stable).
      if (!row.team && e.team) row.team = e.team;
      if (!row.sleeperId && e.sleeperId) row.sleeperId = e.sleeperId;
      if (row.adp[key] === undefined) row.adp[key] = round1(e.adp);
    }
  }

  const rows: MultiAdpRow[] = [];
  for (const row of byName.values()) {
    const vals = Object.values(row.adp).filter((v): v is number => v !== undefined);
    if (!vals.length) continue;
    row.sourceCount = vals.length;
    row.blend = round1(vals.reduce((a, b) => a + b, 0) / vals.length);
    row.spread = vals.length > 1 ? round1(Math.max(...vals) - Math.min(...vals)) : 0;
    rows.push(row);
  }
  rows.sort((a, b) => a.blend - b.blend);
  return rows;
}
