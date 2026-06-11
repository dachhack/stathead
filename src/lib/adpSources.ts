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
 * REDRAFT ONLY: every loader here targets redraft drafts. Sleeper
 * segments formats itself (adp_ppr/adp_2qb are redraft; dynasty startups
 * are the separate adp_dynasty_* fields and supplemental rookie drafts
 * are adp_rookie — both excluded here). FFC mocks are redraft by
 * construction; FantasyCalc is queried with isDynasty=false; ESPN's ADP
 * is its standard redraft game.
 *
 * FORMATS: '1qb' (PPR) or 'sf' (superflex/2QB — radically different QB
 * pricing). SF comes from FFC's 2qb endpoint, Sleeper's adp_2qb, and
 * FantasyCalc numQbs=2; ESPN publishes no SF ADP. No tracked source
 * exposes TE-premium ADP.
 *
 * Sources:
 *  - FFC (FantasyFootballCalculator mock drafts) — committed snapshots
 *    2018+ (`ffc_adp_<scoring>_<season>.json`); current season re-fetched
 *    daily by fetch-ffc-adp.yml. Publishes per-player `times_drafted`
 *    (sample size) and a file-level draft-date window (`meta.end_date`).
 *  - Sleeper draft rooms — committed snapshots 2020+
 *    (`sleeper-adp-<season>.json`); current season re-fetched daily by
 *    fetch-sleeper-players.yml. Sleeper has no ADP before 2020.
 *  - ESPN drafts — live undocumented v3 API, current season only here.
 *  - FantasyCalc — consensus from real leagues; real ADP when populated,
 *    else the overall value rank as a pick proxy. Current season only
 *    (the daily snapshot has no history).
 *
 * BLEND = weighted mean pick across available sources (all sources are
 * overall pick numbers on the same scale). Weights = sample size ×
 * recency: FFC rows are weighted by times_drafted and decayed by the
 * age of the file's draft window (its "year N" endpoint can serve
 * months-old mocks between seasons — the committed 2026 file once
 * carried drafts from Sept 2025), so a stale thin market can't drag
 * players priced before real news. The spread (max − min) is the
 * disagreement signal.
 */

import { fetchFfcADP, fetchEspnADP, fetchFantasyCalcValues } from '../data';
import { normName } from './nameUtils';

export type AdpSourceKey = 'ffc' | 'sleeper' | 'espn' | 'fc';
export type AdpFormat = '1qb' | 'sf';

export const ADP_SOURCE_LABELS: Record<AdpSourceKey, string> = {
  ffc: 'FFC',
  sleeper: 'Sleeper',
  espn: 'ESPN',
  fc: 'FantasyCalc',
};

export const ADP_SOURCE_TITLES: Record<AdpSourceKey, string> = {
  ffc: 'FantasyFootballCalculator mock-draft ADP',
  sleeper: 'Sleeper draft-room ADP',
  espn: 'ESPN live-draft ADP',
  fc: 'FantasyCalc — real ADP when populated, else consensus value rank as a pick proxy',
};

// ── Weighting ──
// Pure math lives in adpBlend.ts (environment-free) so the Node training
// pipeline can share the exact same blend; re-exported here so browser
// surfaces keep importing from one place.
export { recencyWeight, sampleWeight, blendPicks, type WeightedPick } from './adpBlend';
import { recencyWeight, sampleWeight, blendPicks } from './adpBlend';

// ── Row shapes ──

export interface MultiAdpRow {
  name: string;
  position: string;
  team: string;
  sleeperId?: string;
  adp: Partial<Record<AdpSourceKey, number>>;
  /** Weighted mean pick across available sources. */
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
  weight: number;
  sleeperId?: string;
}

// Canonicalize team codes across sources (nflverse-style, as used app-wide).
const TEAM_CANON: Record<string, string> = { LAR: 'LA', WSH: 'WAS', JAC: 'JAX', AZ: 'ARI', ARZ: 'ARI' };
const canonTeam = (t?: string | null): string => (t ? TEAM_CANON[t] ?? t : '');

const SKILL = new Set(['QB', 'RB', 'WR', 'TE']);
const BASE = import.meta.env.BASE_URL;

// ── Loaders ──

interface SleeperAdpDoc {
  season: number;
  fetchedAt?: string;
  players: Array<{
    sleeper_id?: string; name: string; position: string; team?: string;
    adp_ppr?: number; adp_half_ppr?: number; adp_std?: number; adp_2qb?: number;
  }>;
}

async function loadSleeperDoc(season: number): Promise<SleeperAdpDoc | null> {
  try {
    const r = await fetch(`${BASE}data/sleeper-adp-${season}.json`);
    if (!r.ok) return null;
    return (await r.json()) as SleeperAdpDoc;
  } catch {
    return null;
  }
}

async function loadSleeper(season: number, format: AdpFormat, applyRecency: boolean): Promise<RawEntry[]> {
  const doc = await loadSleeperDoc(season);
  if (!doc) return [];
  // Sleeper publishes no per-player draft counts; its volume is the
  // largest of any platform, so the weight is recency-only.
  const weight = applyRecency ? recencyWeight(doc.fetchedAt) : 1;
  return (doc.players ?? [])
    .map((p) => ({
      name: p.name,
      position: p.position,
      team: canonTeam(p.team),
      adp: format === 'sf' ? (p.adp_2qb ?? 0) : (p.adp_ppr ?? p.adp_half_ppr ?? p.adp_std ?? 0),
      weight,
      sleeperId: p.sleeper_id,
    }))
    .filter((p) => p.adp > 0 && p.adp < 999);
}

const ffcScoring = (format: AdpFormat): 'ppr' | '2qb' => (format === 'sf' ? '2qb' : 'ppr');

interface FfcRawDoc {
  meta?: { total_drafts?: number; start_date?: string; end_date?: string };
  players?: Array<{ name: string; position: string; team?: string; adp: number; times_drafted?: number }>;
}

/** Raw committed FFC file — keeps `meta` (draft-date window) and
 *  `times_drafted`, which the mapped fetchFfcADP path discards. */
export async function fetchFfcRaw(season: number, format: AdpFormat = '1qb'): Promise<FfcRawDoc | null> {
  try {
    const r = await fetch(`${BASE}data/ffc_adp_${ffcScoring(format)}_${season}.json`);
    if (!r.ok) return null;
    const doc = (await r.json()) as FfcRawDoc;
    return Array.isArray(doc?.players) ? doc : null;
  } catch {
    return null;
  }
}

function mapFfcRaw(doc: FfcRawDoc, applyRecency: boolean): RawEntry[] {
  const fileW = applyRecency ? recencyWeight(doc.meta?.end_date) : 1;
  return (doc.players ?? [])
    .filter((p) => SKILL.has(p.position) && Number(p.adp) > 0)
    .map((p) => ({
      name: p.name,
      position: p.position,
      team: canonTeam(p.team),
      adp: Number(p.adp),
      weight: sampleWeight(p.times_drafted) * fileW,
    }));
}

async function loadFfcCurrent(season: number, format: AdpFormat): Promise<RawEntry[]> {
  // Committed snapshot first (CI-refreshed daily; carries meta + counts)…
  const raw = await fetchFfcRaw(season, format);
  if (raw && (raw.players?.length ?? 0) > 0) return mapFfcRaw(raw, true);
  // …else the live-API path (no meta — assume fresh, unknown sample).
  try {
    const players = await fetchFfcADP(season, ffcScoring(format), 12);
    return players
      .filter((p) => SKILL.has(p.position) && p.adp > 0)
      .map((p) => ({
        name: p.name, position: p.position, team: canonTeam(p.team),
        adp: p.adp, weight: sampleWeight(p.timesDrafted),
      }));
  } catch {
    return [];
  }
}

// Snapshot-only FFC for historic seasons — no live-API fallback, so
// research is deterministic. Sample weights still apply (a 5-mock ADP
// from 2021 is as noisy as one from today); recency does not.
async function loadFfcSnapshot(season: number, format: AdpFormat): Promise<RawEntry[]> {
  const raw = await fetchFfcRaw(season, format);
  return raw ? mapFfcRaw(raw, false) : [];
}

async function loadEspn(season: number): Promise<RawEntry[]> {
  try {
    const players = await fetchEspnADP(season);
    return players
      .filter((p) => SKILL.has(p.position) && p.adp > 0)
      .map((p) => ({ name: p.name, position: p.position, team: canonTeam(p.team), adp: p.adp, weight: 1 }));
  } catch {
    return [];
  }
}

async function loadFc(format: AdpFormat): Promise<RawEntry[]> {
  try {
    const players = await fetchFantasyCalcValues(false, format === 'sf' ? 2 : 1, 12, 1);
    return players
      .filter((p) => SKILL.has(p.player.position))
      .map((p) => {
        const realAdp = p.maybeAdp != null && p.maybeAdp > 0;
        return {
          name: p.player.name,
          position: p.player.position,
          team: canonTeam(p.player.maybeTeam),
          adp: realAdp ? (p.maybeAdp as number) : p.overallRank,
          // A consensus value rank is a pick proxy, not a sampled pick —
          // half weight until FC's real ADP populates.
          weight: realAdp ? 1 : 0.5,
          sleeperId: p.player.sleeperId,
        };
      });
  } catch {
    return [];
  }
}

export interface AdpSourceData {
  season: number;
  format: AdpFormat;
  sources: Record<AdpSourceKey, RawEntry[]>;
}

/** Historic regime: committed snapshots only (FFC + Sleeper), no live
 *  calls — same numbers on every run. The research/training input. */
export async function loadHistoricAdpSources(season: number, format: AdpFormat = '1qb'): Promise<AdpSourceData> {
  const [ffc, sleeper] = await Promise.all([
    loadFfcSnapshot(season, format),
    loadSleeper(season, format, false),
  ]);
  return { season, format, sources: { ffc, sleeper, espn: [], fc: [] } };
}

/** Current regime: every live + daily-refreshed source. The input for
 *  scoring, projections, and draft optimization. ESPN has no SF ADP. */
export async function loadCurrentAdpSources(season: number, format: AdpFormat = '1qb'): Promise<AdpSourceData> {
  const [ffc, sleeper, espn, fc] = await Promise.all([
    loadFfcCurrent(season, format),
    loadSleeper(season, format, true),
    format === '1qb' ? loadEspn(season) : Promise.resolve([] as RawEntry[]),
    loadFc(format),
  ]);
  return { season, format, sources: { ffc, sleeper, espn, fc } };
}

/** Route to the right regime for the requested season. */
export async function loadAdpSources(season: number, currentSeason: number, format: AdpFormat = '1qb'): Promise<AdpSourceData> {
  return season < currentSeason ? loadHistoricAdpSources(season, format) : loadCurrentAdpSources(season, format);
}

const round1 = (v: number): number => Math.round(v * 10) / 10;

/** Join the sources by player and compute the weighted blend + the
 *  disagreement spread. */
export function buildMultiAdpRows(data: AdpSourceData): MultiAdpRow[] {
  interface Acc extends MultiAdpRow { weights: Partial<Record<AdpSourceKey, number>> }
  const byName = new Map<string, Acc>();
  for (const key of Object.keys(data.sources) as AdpSourceKey[]) {
    for (const e of data.sources[key]) {
      const nn = normName(e.name);
      if (!nn) continue;
      let row = byName.get(nn);
      if (!row) {
        row = { name: e.name, position: e.position, team: '', adp: {}, weights: {}, blend: 0, spread: 0, sourceCount: 0 };
        byName.set(nn, row);
      }
      // First source to provide a team/id wins (source order is stable).
      if (!row.team && e.team) row.team = e.team;
      if (!row.sleeperId && e.sleeperId) row.sleeperId = e.sleeperId;
      if (row.adp[key] === undefined) {
        row.adp[key] = round1(e.adp);
        row.weights[key] = e.weight;
      }
    }
  }

  const rows: MultiAdpRow[] = [];
  for (const row of byName.values()) {
    const picks = (Object.keys(row.adp) as AdpSourceKey[])
      .map((k) => ({ adp: row.adp[k]!, weight: row.weights[k] ?? 1 }));
    if (!picks.length) continue;
    const blend = blendPicks(...picks);
    if (blend === undefined) continue;
    const vals = picks.map((p) => p.adp);
    row.sourceCount = vals.length;
    row.blend = blend;
    row.spread = vals.length > 1 ? round1(Math.max(...vals) - Math.min(...vals)) : 0;
    rows.push(row);
  }
  rows.sort((a, b) => a.blend - b.blend);
  return rows;
}
