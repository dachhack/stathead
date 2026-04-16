import Papa from 'papaparse';
import { ROSTER_OVERRIDES_2026, ROSTER_OVERRIDES_2026_SEASON } from './rosterOverrides';
import type {
  PlayerStats,
  SeasonTotals,
  Game,
  SnapCount,
  CombineResult,
  DraftPick,
  Injury,
  AdvancedStats,
  PlayByPlay,
  FantasyRanking,
  FantasySeasonResult,
  EspnADPPlayer,
  FfcADPPlayer,
  SleeperTrendingPlayer,
  SleeperPlayer,
  SleeperTrendingRow,
  SleeperProjection,
  KTCPlayer,
  KTCPlayerHistory,
  FantasyCalcPlayer,
  NextGenStats,
  Roster,
  Contract,
  DepthChart,
  FTNCharting,
  Trade,
  QBRSeason,
  QBRWeek,
  DraftProspect,
  DraftProfile,
  CollegeStats,
  CollegeQBR,
} from './types';

const NFLVERSE_REMOTE =
  'https://github.com/nflverse/nflverse-data/releases/download';

// ── Fetch timeout wrapper ──
// All network requests use this to avoid hanging indefinitely.
const DEFAULT_TIMEOUT = 30_000;  // 30s for API calls
const LARGE_CSV_TIMEOUT = 60_000; // 60s for large CSVs (PBP, stats)

async function fetchWithTimeout(
  url: string,
  options?: RequestInit & { timeout?: number },
): Promise<Response> {
  const ms = options?.timeout ?? DEFAULT_TIMEOUT;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    const { timeout: _, ...fetchOpts } = options ?? {};
    return await fetch(url, { ...fetchOpts, signal: controller.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(`Request timed out after ${ms}ms: ${url.slice(0, 120)}`);
    }
    throw err;
  } finally {
    clearTimeout(id);
  }
}

// In production, nflverse CSVs are pre-downloaded into /data/ at build time
// as a flat directory. Locally, fetch directly from GitHub releases.
const IS_PROD = typeof window !== 'undefined' && window.location.hostname !== 'localhost';

// In Node.js (build scripts), check if local files exist in public/data/
const IS_NODE = typeof window === 'undefined';

/** Read a local file in Node, returns null if not found */
async function readLocalFile(filename: string): Promise<string | null> {
  if (!IS_NODE) return null;
  try {
    const fs = await import('fs');
    const path = `public/data/${filename}`;
    if (fs.existsSync(path)) {
      return fs.readFileSync(path, 'utf-8');
    }
  } catch {}
  return null;
}

// CORS proxy for KeepTradeCut (Cloudflare Worker).
// Deploy workers/ktc-proxy/ and set this to your worker URL.
const KTC_PROXY = 'https://ktc-proxy.dachhack.workers.dev';

/** Try loading a pre-fetched JSON file from /data/. Returns null on failure. */
async function tryPreFetched<T>(filename: string): Promise<T | null> {
  // In Node, try local file first
  const localText = await readLocalFile(filename);
  if (localText) {
    try { return JSON.parse(localText) as T; } catch { return null; }
  }
  if (!IS_PROD) return null;
  try {
    const resp = await fetchWithTimeout(`${import.meta.env.BASE_URL}data/${filename}`);
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

/** Build a URL for an nflverse CSV file. In prod, serves from local /data/filename.csv */
function nflUrl(releaseSubpath: string): string {
  if (IS_PROD) {
    // Extract just the filename from paths like "player_stats/player_stats_2024.csv"
    const filename = releaseSubpath.split('/').pop()!;
    return `${import.meta.env.BASE_URL}data/${filename}`;
  }
  return `${NFLVERSE_REMOTE}/${releaseSubpath}`;
}

// nflverse renamed the player_stats release to stats_player starting ~2025
// with column renames: recent_team→team, interceptions→passing_interceptions,
// sacks→sacks_suffered, sack_yards→sack_yards_lost, dakota removed
const NEW_COL_MAP: Record<string, string> = {
  team: 'recent_team',
  passing_interceptions: 'interceptions',
  sacks_suffered: 'sacks',
  sack_yards_lost: 'sack_yards',
  passing_cpoe: 'dakota', // closest equivalent
};

function normalizePlayerRow(row: Record<string, unknown>): Record<string, unknown> {
  for (const [newCol, oldCol] of Object.entries(NEW_COL_MAP)) {
    if (newCol in row && !(oldCol in row)) {
      row[oldCol] = row[newCol];
    }
  }
  return row;
}

export async function fetchPlayerStats(season: number): Promise<PlayerStats[]> {
  // In Node, try local file first
  const localText = await readLocalFile(`player_stats_${season}.csv`);
  if (localText) {
    const result = Papa.parse<PlayerStats>(localText, {
      header: true, dynamicTyping: true, skipEmptyLines: true,
    });
    const data = (result.data as unknown as Record<string, unknown>[])
      .map(normalizePlayerRow) as unknown as PlayerStats[];
    return data.filter((row) => row.season_type === 'REG');
  }

  // Try legacy release first then new stats_player release
  const urls = IS_NODE
    ? [
        `${NFLVERSE_REMOTE}/player_stats/player_stats_${season}.csv`,
        `${NFLVERSE_REMOTE}/stats_player/stats_player_week_${season}.csv`,
      ]
    : IS_PROD
    ? [
        nflUrl(`player_stats/player_stats_${season}.csv`),
        nflUrl(`stats_player/stats_player_week_${season}.csv`),
      ]
    : [
        `${NFLVERSE_REMOTE}/player_stats/player_stats_${season}.csv`,
        `${NFLVERSE_REMOTE}/stats_player/stats_player_week_${season}.csv`,
      ];

  let text = '';
  for (const url of urls) {
    const response = await fetchWithTimeout(url, { timeout: LARGE_CSV_TIMEOUT });
    if (response.ok) {
      text = await response.text();
      if (text.trim()) break;
    }
  }
  if (!text.trim()) return [];

  const result = Papa.parse<Record<string, unknown>>(text, {
    header: true,
    dynamicTyping: true,
    skipEmptyLines: true,
  });

  // Detect new nflverse schema by column name and normalize
  if (result.data.length > 0 && 'passing_interceptions' in result.data[0]) {
    result.data.forEach(normalizePlayerRow);
  }

  // Filter to regular season only
  return (result.data as unknown as PlayerStats[]).filter((row) => row.season_type === 'REG');
}

export function aggregateToSeasonTotals(
  weeklyStats: PlayerStats[]
): SeasonTotals[] {
  const playerMap = new Map<string, SeasonTotals>();

  for (const week of weeklyStats) {
    const key = `${week.player_id}-${week.season}`;
    const existing = playerMap.get(key);

    if (!existing) {
      playerMap.set(key, {
        player_id: week.player_id,
        player_name: week.player_name,
        player_display_name: week.player_display_name,
        position: week.position,
        headshot_url: week.headshot_url,
        recent_team: week.recent_team,
        season: week.season,
        games: 1,
        completions: week.completions || 0,
        attempts: week.attempts || 0,
        passing_yards: week.passing_yards || 0,
        passing_tds: week.passing_tds || 0,
        interceptions: week.interceptions || 0,
        carries: week.carries || 0,
        rushing_yards: week.rushing_yards || 0,
        rushing_tds: week.rushing_tds || 0,
        receptions: week.receptions || 0,
        targets: week.targets || 0,
        receiving_yards: week.receiving_yards || 0,
        receiving_tds: week.receiving_tds || 0,
        fantasy_points: week.fantasy_points || 0,
        fantasy_points_ppr: week.fantasy_points_ppr || 0,
        fantasy_points_half_ppr: 0,
        rushing_fumbles_lost: week.rushing_fumbles_lost || 0,
        receiving_fumbles_lost: week.receiving_fumbles_lost || 0,
        sack_fumbles_lost: week.sack_fumbles_lost || 0,
        passing_2pt_conversions: week.passing_2pt_conversions || 0,
        rushing_2pt_conversions: week.rushing_2pt_conversions || 0,
        receiving_2pt_conversions: week.receiving_2pt_conversions || 0,
        special_teams_tds: week.special_teams_tds || 0,
      });
    } else {
      existing.games += 1;
      existing.completions += week.completions || 0;
      existing.attempts += week.attempts || 0;
      existing.passing_yards += week.passing_yards || 0;
      existing.passing_tds += week.passing_tds || 0;
      existing.interceptions += week.interceptions || 0;
      existing.carries += week.carries || 0;
      existing.rushing_yards += week.rushing_yards || 0;
      existing.rushing_tds += week.rushing_tds || 0;
      existing.receptions += week.receptions || 0;
      existing.targets += week.targets || 0;
      existing.receiving_yards += week.receiving_yards || 0;
      existing.receiving_tds += week.receiving_tds || 0;
      existing.fantasy_points += week.fantasy_points || 0;
      existing.fantasy_points_ppr += week.fantasy_points_ppr || 0;
      existing.rushing_fumbles_lost += week.rushing_fumbles_lost || 0;
      existing.receiving_fumbles_lost += week.receiving_fumbles_lost || 0;
      existing.sack_fumbles_lost += week.sack_fumbles_lost || 0;
      existing.passing_2pt_conversions += week.passing_2pt_conversions || 0;
      existing.rushing_2pt_conversions += week.rushing_2pt_conversions || 0;
      existing.receiving_2pt_conversions += week.receiving_2pt_conversions || 0;
      existing.special_teams_tds += week.special_teams_tds || 0;
      // Update team to most recent
      existing.recent_team = week.recent_team;
    }
  }

  // Calculate half PPR
  for (const player of playerMap.values()) {
    player.fantasy_points_half_ppr =
      player.fantasy_points + player.receptions * 0.5;
  }

  return Array.from(playerMap.values());
}

const FANTASY_POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K'];

export function filterFantasyRelevant(players: SeasonTotals[]): SeasonTotals[] {
  return players.filter(
    (p) => FANTASY_POSITIONS.includes(p.position) && p.games >= 1
  );
}

// --- Generic CSV fetcher with caching ---
const csvCache = new Map<string, unknown[]>();

async function fetchCsv<T>(url: string): Promise<T[]> {
  const cached = csvCache.get(url);
  if (cached) return cached as T[];

  // In Node, try local file first (from public/data/)
  const filename = url.split('/').pop()!;
  const localText = await readLocalFile(filename);
  if (localText) {
    const result = Papa.parse<T>(localText, {
      header: true,
      dynamicTyping: true,
      skipEmptyLines: true,
    });
    csvCache.set(url, result.data);
    return result.data;
  }

  const response = await fetchWithTimeout(url, { timeout: LARGE_CSV_TIMEOUT });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  const text = await response.text();
  const result = Papa.parse<T>(text, {
    header: true,
    dynamicTyping: true,
    skipEmptyLines: true,
  });
  csvCache.set(url, result.data as unknown[]);
  return result.data;
}

// --- Games / Schedules ---
export async function fetchGames(): Promise<Game[]> {
  return fetchCsv<Game>(nflUrl(`schedules/games.csv`));
}

// --- Snap Counts ---
export async function fetchSnapCounts(season: number): Promise<SnapCount[]> {
  return fetchCsv<SnapCount>(nflUrl(`snap_counts/snap_counts_${season}.csv`));
}

// --- Combine ---
export async function fetchCombine(): Promise<CombineResult[]> {
  return fetchCsv<CombineResult>(nflUrl(`combine/combine.csv`));
}

// --- Draft Picks ---
export async function fetchDraftPicks(): Promise<DraftPick[]> {
  return fetchCsv<DraftPick>(nflUrl(`draft_picks/draft_picks.csv`));
}

// --- Injuries ---
export async function fetchInjuries(season: number): Promise<Injury[]> {
  return fetchCsv<Injury>(nflUrl(`injuries/injuries_${season}.csv`));
}

// --- PFR Advanced Stats ---
export async function fetchAdvancedStats(
  season: number,
  type: 'pass' | 'rush' | 'rec' | 'def' = 'pass'
): Promise<AdvancedStats[]> {
  return fetchCsv<AdvancedStats>(nflUrl(`pfr_advstats/advstats_week_${type}_${season}.csv`));
}

// --- Play-by-Play ---
export async function fetchPlayByPlay(season: number): Promise<PlayByPlay[]> {
  const url = nflUrl(`pbp/play_by_play_${season}.csv`);
  // PBP files are large, so we parse with specific columns to save memory
  const response = await fetchWithTimeout(url, { timeout: LARGE_CSV_TIMEOUT });
  if (!response.ok) {
    throw new Error(`Failed to fetch PBP for ${season}: ${response.status}`);
  }
  const text = await response.text();
  const result = Papa.parse<PlayByPlay>(text, {
    header: true,
    dynamicTyping: true,
    skipEmptyLines: true,
  });
  // Filter out rows without a valid play_type to reduce noise
  return result.data.filter(
    (row) => row.play_type && row.play_type !== 'no_play'
  );
}

// --- PBP Participation (NGS-sourced per-play participation data) ---
export async function fetchPbpParticipation(
  season: number
): Promise<import('./types').PbpParticipation[]> {
  return fetchCsv<import('./types').PbpParticipation>(nflUrl(`pbp_participation/pbp_participation_${season}.csv`));
}

// --- Fantasy Rankings (FantasyPros ECR via dynastyprocess) ---
const DYNASTYPROCESS =
  'https://github.com/dynastyprocess/data/raw/master/files';

export async function fetchFantasyRankings(): Promise<FantasyRanking[]> {
  const url = IS_PROD
    ? `${import.meta.env.BASE_URL}data/db_fpecr_latest.csv`
    : `${DYNASTYPROCESS}/db_fpecr_latest.csv`;
  return fetchCsv<FantasyRanking>(url);
}

// --- Fantasy Season Results: merge ADP with actual production ---
export function buildSeasonResults(
  seasonTotals: SeasonTotals[],
  rankings: FantasyRanking[]
): FantasySeasonResult[] {
  // Filter to redraft-overall rankings for ADP comparison
  const adpMap = new Map<string, FantasyRanking>();
  const redraftOverall = rankings.filter(
    (r) =>
      r.page_type === 'redraft-overall' ||
      r.page_type === 'best-overall'
  );
  for (const r of redraftOverall) {
    // Match by normalized player name
    const key = normalizeName(r.player);
    if (!adpMap.has(key)) adpMap.set(key, r);
  }

  // Sort players by standard fantasy points for overall ranking
  const sortedStd = [...seasonTotals].sort(
    (a, b) => b.fantasy_points - a.fantasy_points
  );
  const sortedPpr = [...seasonTotals].sort(
    (a, b) => b.fantasy_points_ppr - a.fantasy_points_ppr
  );

  // Build position ranks
  const posRankStd = new Map<string, number>();
  const posRankPpr = new Map<string, number>();
  const posCountersStd: Record<string, number> = {};
  const posCountersPpr: Record<string, number> = {};

  for (const p of sortedStd) {
    posCountersStd[p.position] = (posCountersStd[p.position] || 0) + 1;
    posRankStd.set(p.player_id, posCountersStd[p.position]);
  }
  for (const p of sortedPpr) {
    posCountersPpr[p.position] = (posCountersPpr[p.position] || 0) + 1;
    posRankPpr.set(p.player_id, posCountersPpr[p.position]);
  }

  return sortedPpr.map((p, i) => {
    const nameKey = normalizeName(p.player_display_name);
    const adp = adpMap.get(nameKey);
    const overallRankPpr = i + 1;
    const overallRankStd =
      sortedStd.findIndex((s) => s.player_id === p.player_id) + 1;

    return {
      player_display_name: p.player_display_name,
      player_id: p.player_id,
      position: p.position,
      team: p.recent_team,
      headshot_url: p.headshot_url,
      games: p.games,
      fantasy_points: p.fantasy_points,
      fantasy_points_ppr: p.fantasy_points_ppr,
      fantasy_points_half_ppr: p.fantasy_points_half_ppr,
      overall_rank_std: overallRankStd,
      overall_rank_ppr: overallRankPpr,
      pos_rank_std: posRankStd.get(p.player_id) || 0,
      pos_rank_ppr: posRankPpr.get(p.player_id) || 0,
      adp_ecr: adp ? adp.ecr : null,
      adp_pos: adp ? adp.pos : null,
      adp_delta: adp ? adp.ecr - overallRankPpr : null,
    };
  });
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// --- Fantasy Football Calculator ADP (free REST API) ---

// FFC uses different team abbreviations than nflverse for some franchises
const FFC_TEAM_TO_NFLVERSE: Record<string, string> = {
  LAR: 'LA', // Rams: FFC uses 'LAR', nflverse uses 'LA'
};

function normalizeFfcTeam(team: string): string {
  return FFC_TEAM_TO_NFLVERSE[team] ?? team;
}

const ffcAdpCache = new Map<string, FfcADPPlayer[]>();

export async function fetchFfcADP(
  season: number,
  scoring: 'standard' | 'ppr' | 'half-ppr' | '2qb' = 'ppr',
  teams: number = 12
): Promise<FfcADPPlayer[]> {
  const cacheKey = `${season}-${scoring}-${teams}`;
  const cached = ffcAdpCache.get(cacheKey);
  if (cached) return cached;

  // Try pre-fetched data
  const preFetched = await tryPreFetched<{ players?: Array<Record<string, unknown>> }>(`ffc_adp_${scoring}_${season}.json`);
  if (preFetched?.players && preFetched.players.length > 0) {
    const players: FfcADPPlayer[] = preFetched.players.map((p) => ({
      name: String(p.name || ''),
      position: String(p.position || ''),
      team: normalizeFfcTeam(String(p.team || '')),
      adp: Number(p.adp) || 0,
      high: Number(p.high) || 0,
      low: Number(p.low) || 0,
      stdev: Number(p.stdev) || 0,
      timesDrafted: Number(p.times_drafted) || 0,
      bye: Number(p.bye) || 0,
    }));
    ffcAdpCache.set(cacheKey, players);
    return players;
  }

  const url = `https://fantasyfootballcalculator.com/api/v1/adp/${scoring}?teams=${teams}&year=${season}`;
  const response = await fetchWithTimeout(url);
  if (!response.ok) {
    throw new Error(`FFC API returned ${response.status}`);
  }

  const json = await response.json();
  const rawPlayers: Array<Record<string, unknown>> = json.players || [];

  const players: FfcADPPlayer[] = rawPlayers.map((p) => ({
    name: String(p.name || ''),
    position: String(p.position || ''),
    team: normalizeFfcTeam(String(p.team || '')),
    adp: Number(p.adp) || 0,
    high: Number(p.high) || 0,
    low: Number(p.low) || 0,
    stdev: Number(p.stdev) || 0,
    timesDrafted: Number(p.times_drafted) || 0,
    bye: Number(p.bye) || 0,
  }));

  ffcAdpCache.set(cacheKey, players);
  return players;
}

// --- ESPN Fantasy ADP (undocumented v3 API) ---

const ESPN_POSITION_MAP: Record<number, string> = {
  1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'DST',
};

const ESPN_TEAM_MAP: Record<number, string> = {
  0: 'FA', 1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE',
  6: 'DAL', 7: 'DEN', 8: 'DET', 9: 'GB', 10: 'TEN', 11: 'IND',
  12: 'KC', 13: 'LV', 14: 'LAR', 15: 'MIA', 16: 'MIN', 17: 'NE',
  18: 'NO', 19: 'NYG', 20: 'NYJ', 21: 'PHI', 22: 'ARI', 23: 'PIT',
  24: 'LAC', 25: 'SF', 26: 'SEA', 27: 'TB', 28: 'WSH', 29: 'CAR',
  30: 'JAX', 33: 'BAL', 34: 'HOU',
};

interface EspnPlayerRaw {
  id: number;
  fullName?: string;
  firstName?: string;
  lastName?: string;
  defaultPositionId: number;
  proTeamId: number;
  ownership?: {
    averageDraftPosition?: number;
    percentOwned?: number;
  };
  draftRanksByRankType?: {
    STANDARD?: { rank: number; auctionValue: number };
    PPR?: { rank: number; auctionValue: number };
  };
}

interface EspnPlayersResponse {
  players: Array<{
    id: number;
    player: EspnPlayerRaw;
  }>;
}

function parseEspnResponse(raw: unknown): EspnADPPlayer[] {
  const playerEntries: Array<{ id: number; player?: EspnPlayerRaw } & EspnPlayerRaw> =
    Array.isArray(raw) ? raw : (raw as EspnPlayersResponse).players || [];

  const players: EspnADPPlayer[] = [];
  for (const entry of playerEntries) {
    const p = entry.player || entry;
    const pos = ESPN_POSITION_MAP[p.defaultPositionId];
    if (!pos) continue;

    const name = p.fullName || `${p.firstName || ''} ${p.lastName || ''}`.trim();
    if (!name) continue;

    const stdRank = p.draftRanksByRankType?.STANDARD;
    const pprRank = p.draftRanksByRankType?.PPR;

    players.push({
      espnId: p.id || entry.id,
      name,
      position: pos,
      team: ESPN_TEAM_MAP[p.proTeamId] || 'FA',
      adp: p.ownership?.averageDraftPosition || 0,
      percentOwned: p.ownership?.percentOwned || 0,
      draftRankStd: stdRank?.rank || 0,
      draftRankPpr: pprRank?.rank || 0,
      auctionValueStd: stdRank?.auctionValue || 0,
      auctionValuePpr: pprRank?.auctionValue || 0,
    });
  }

  players.sort((a, b) => (a.draftRankPpr || 999) - (b.draftRankPpr || 999));
  return players;
}

const espnAdpCache = new Map<number, EspnADPPlayer[]>();

export async function fetchEspnADP(season: number): Promise<EspnADPPlayer[]> {
  const cached = espnAdpCache.get(season);
  if (cached) return cached;

  // Try pre-fetched raw ESPN data
  const preFetchedRaw = await tryPreFetched<unknown>(`espn_adp_${season}.json`);
  if (preFetchedRaw) {
    const players = parseEspnResponse(preFetchedRaw);
    if (players.length > 0) {
      espnAdpCache.set(season, players);
      return players;
    }
  }

  // Use the league-free players endpoint with kona_player_info view
  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/players?scoringPeriodId=0&view=players_wl`;

  const filter = {
    players: {
      limit: 500,
      sortDraftRanks: {
        sortPriority: 100,
        sortAsc: true,
        value: 'PPR',
      },
    },
  };

  const response = await fetchWithTimeout(url, {
    headers: {
      'x-fantasy-filter': JSON.stringify(filter),
    },
  });

  if (!response.ok) {
    throw new Error(`ESPN API returned ${response.status}`);
  }

  const raw = await response.json();
  const players = parseEspnResponse(raw);

  espnAdpCache.set(season, players);
  return players;
}

// --- Sleeper API ---

const SLEEPER = 'https://api.sleeper.app/v1';

let sleeperPlayersCache: Map<string, SleeperPlayer> | null = null;

export async function fetchSleeperPlayers(): Promise<Map<string, SleeperPlayer>> {
  if (sleeperPlayersCache) return sleeperPlayersCache;

  const response = await fetchWithTimeout(`${SLEEPER}/players/nfl`);
  if (!response.ok) throw new Error(`Sleeper players API returned ${response.status}`);

  const raw: Record<string, Record<string, unknown>> = await response.json();
  const map = new Map<string, SleeperPlayer>();

  for (const [id, p] of Object.entries(raw)) {
    if (!p.position || !p.full_name) continue;
    map.set(id, {
      player_id: id,
      full_name: String(p.full_name || ''),
      first_name: String(p.first_name || ''),
      last_name: String(p.last_name || ''),
      position: String(p.position || ''),
      team: String(p.team || ''),
      age: Number(p.age) || 0,
      years_exp: Number(p.years_exp) || 0,
      number: Number(p.number) || 0,
      status: String(p.status || ''),
      sport: String(p.sport || 'nfl'),
      fantasy_positions: Array.isArray(p.fantasy_positions) ? p.fantasy_positions.map(String) : [],
      depth_chart_order: p.depth_chart_order != null ? Number(p.depth_chart_order) : null,
      search_rank: p.search_rank != null ? Number(p.search_rank) : null,
    });
  }

  sleeperPlayersCache = map;
  return map;
}

export async function fetchSleeperTrending(
  type: 'add' | 'drop' = 'add',
  hours: number = 24,
  limit: number = 50
): Promise<SleeperTrendingRow[]> {
  const [trendingRes, players] = await Promise.all([
    fetchWithTimeout(`${SLEEPER}/players/nfl/trending/${type}?lookback_hours=${hours}&limit=${limit}`),
    fetchSleeperPlayers(),
  ]);

  if (!trendingRes.ok) throw new Error(`Sleeper trending API returned ${trendingRes.status}`);
  const trending: SleeperTrendingPlayer[] = await trendingRes.json();

  return trending
    .map((t) => {
      const p = players.get(t.player_id);
      if (!p) return null;
      return {
        player_id: t.player_id,
        full_name: p.full_name,
        position: p.position,
        team: p.team || 'FA',
        age: p.age,
        count: t.count,
      };
    })
    .filter((r): r is SleeperTrendingRow => r !== null);
}

const sleeperProjectionCache = new Map<string, SleeperProjection[]>();

export async function fetchSleeperProjections(
  season: number,
  week?: number
): Promise<SleeperProjection[]> {
  const cacheKey = `${season}-${week ?? 'full'}`;
  const cached = sleeperProjectionCache.get(cacheKey);
  if (cached) return cached;

  const url = week
    ? `${SLEEPER}/projections/nfl/${season}/${week}?season_type=regular`
    : `${SLEEPER}/projections/nfl/${season}`;

  const [projRes, players] = await Promise.all([
    fetchWithTimeout(url),
    fetchSleeperPlayers(),
  ]);

  if (!projRes.ok) throw new Error(`Sleeper projections API returned ${projRes.status}`);
  const raw: Record<string, Record<string, number>> = await projRes.json();

  const projections: SleeperProjection[] = [];
  for (const [pid, stats] of Object.entries(raw)) {
    const p = players.get(pid);
    if (!p || !['QB', 'RB', 'WR', 'TE', 'K'].includes(p.position)) continue;

    const passYd = stats.pass_yd || 0;
    const passTd = stats.pass_td || 0;
    const passInt = stats.pass_int || 0;
    const rushYd = stats.rush_yd || 0;
    const rushTd = stats.rush_td || 0;
    const rec = stats.rec || 0;
    const recYd = stats.rec_yd || 0;
    const recTd = stats.rec_td || 0;
    const fum = stats.fum_lost || 0;

    // Calculate projected fantasy points
    const ptsStd = passYd * 0.04 + passTd * 4 - passInt * 2 +
      rushYd * 0.1 + rushTd * 6 + recYd * 0.1 + recTd * 6 - fum * 2;
    const ptsPpr = ptsStd + rec;
    const ptsHalfPpr = ptsStd + rec * 0.5;

    projections.push({
      player_id: pid,
      full_name: p.full_name,
      position: p.position,
      team: p.team || 'FA',
      pts_std: Math.round(ptsStd * 10) / 10,
      pts_half_ppr: Math.round(ptsHalfPpr * 10) / 10,
      pts_ppr: Math.round(ptsPpr * 10) / 10,
      pass_yd: passYd,
      pass_td: passTd,
      pass_int: passInt,
      rush_yd: rushYd,
      rush_td: rushTd,
      rec,
      rec_yd: recYd,
      rec_td: recTd,
    });
  }

  projections.sort((a, b) => b.pts_ppr - a.pts_ppr);
  sleeperProjectionCache.set(cacheKey, projections);
  return projections;
}

// --- KeepTradeCut (scrapes embedded playersArray from HTML) ---

const ktcCache = new Map<string, KTCPlayer[]>();

export async function fetchKTCRankings(
  format: '1qb' | 'superflex' = '1qb'
): Promise<KTCPlayer[]> {
  const cached = ktcCache.get(format);
  if (cached) return cached;

  // Try pre-fetched data first
  const preFetched = await tryPreFetched<KTCPlayer[]>(`ktc_rankings_${format}.json`);
  if (preFetched && preFetched.length > 0) {
    preFetched.sort((a, b) => b.value - a.value);
    ktcCache.set(format, preFetched);
    return preFetched;
  }

  const allPlayers: KTCPlayer[] = [];
  const seen = new Set<number>(); // deduplicate playerIDs across pages
  const formatParam = format === '1qb' ? '1' : '0';

  // KTC paginates across 10 pages
  for (let page = 0; page < 10; page++) {
    const ktcPath = `/dynasty-rankings?page=${page}&filters=QB|WR|RB|TE|RDP&format=${formatParam}`;
    const url = IS_PROD
      ? `${KTC_PROXY}${ktcPath}`
      : `https://keeptradecut.com${ktcPath}`;
    const response = await fetchWithTimeout(url);
    if (!response.ok) {
      if (page === 0) throw new Error(`KTC returned ${response.status}`);
      break; // Later pages may not exist
    }

    const html = await response.text();

    // Extract the playersArray variable embedded in the page's script tags
    const match = html.match(/var\s+playersArray\s*=\s*(\[[\s\S]*?\]);/);
    if (!match) {
      if (page === 0) throw new Error('Could not find player data in KTC page');
      break;
    }

    try {
      const players: Array<Record<string, unknown>> = JSON.parse(match[1]);
      let added = 0;
      for (const p of players) {
        const id = Number(p.playerID) || 0;
        if (seen.has(id)) continue; // deduplicate across pages
        seen.add(id);
        // KTC moved values into nested objects: oneQBValues.value / superflexValues.value
        // Support both old flat shape (p.value) and new nested shape for resilience
        const oneQB = p.oneQBValues as Record<string, unknown> | undefined;
        const sf    = p.superflexValues as Record<string, unknown> | undefined;
        const value1qb = Number(oneQB?.value ?? p.value) || 0;
        const valueSF  = Number(sf?.value ?? p.superflexValue) || 0;
        const posRank  = Number(oneQB?.positionalRank ?? p.positionRank) || 0;
        allPlayers.push({
          playerID: id,
          playerName: String(p.playerName || ''),
          position: String(p.position || ''),
          positionRank: posRank,
          team: String(p.team || ''),
          age: Number(p.age) || 0,
          value: value1qb,
          superflexValue: valueSF,
          isRookie: Boolean(p.isRookie ?? p.rookie),
          slug: String(p.slug || ''),
        });
        added++;
      }
      if (added === 0) break; // no new players on this page — stop early
    } catch {
      if (page === 0) throw new Error('Failed to parse KTC player data');
      break;
    }
  }

  // Sort by value descending
  allPlayers.sort((a, b) => b.value - a.value);
  ktcCache.set(format, allPlayers);
  return allPlayers;
}

// --- KTC Player History (POST endpoint) ---

const ktcHistoryCache = new Map<number, KTCPlayerHistory>();

export async function fetchKTCHistory(
  playerIDs: number[]
): Promise<KTCPlayerHistory[]> {
  // Try loading pre-fetched history (already parsed into {d,v} objects)
  if (ktcHistoryCache.size === 0) {
    const preFetched = await tryPreFetched<KTCPlayerHistory[]>('ktc_history.json');
    if (preFetched) {
      for (const entry of preFetched) {
        ktcHistoryCache.set(entry.playerID, entry);
      }
    }
  }

  // Return cached entries where available, fetch the rest
  const results: KTCPlayerHistory[] = [];
  const toFetch: number[] = [];

  for (const id of playerIDs) {
    const cached = ktcHistoryCache.get(id);
    if (cached) {
      results.push(cached);
    } else {
      toFetch.push(id);
    }
  }

  if (toFetch.length > 0) {
    const historyUrl = IS_PROD
      ? `${KTC_PROXY}/dynasty-rankings/histories`
      : 'https://keeptradecut.com/dynasty-rankings/histories';
    const response = await fetchWithTimeout(historyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toFetch),
    });

    if (!response.ok) {
      throw new Error(`KTC history API returned ${response.status}`);
    }

    const raw = await response.json();
    for (const entry of raw) {
      // KTC returns valueHistory as packed strings "YYMMDDVVVV..."
      // Convert to { d: "YYYY-MM-DD", v: number } objects
      const parseHistory = (arr: (string | { d: string; v: number })[]) =>
        arr.map((item) => {
          if (typeof item === 'object') return item;
          const s = String(item);
          const yy = s.slice(0, 2);
          const mm = s.slice(2, 4);
          const dd = s.slice(4, 6);
          const v = Number(s.slice(6));
          return { d: `20${yy}-${mm}-${dd}`, v };
        });
      const parsed: KTCPlayerHistory = {
        playerID: entry.playerID,
        oneQB: { valueHistory: parseHistory(entry.oneQB.valueHistory) },
        superflex: { valueHistory: parseHistory(entry.superflex.valueHistory) },
      };
      ktcHistoryCache.set(parsed.playerID, parsed);
      results.push(parsed);
    }
  }

  return results;
}

// --- FantasyCalc Rankings (normalized to KTCPlayer shape) ---

const fcCache = new Map<string, KTCPlayer[]>();

export async function fetchFantasyCalcRankings(
  format: '1qb' | 'superflex' = '1qb'
): Promise<KTCPlayer[]> {
  const cacheKey = format;
  const cached = fcCache.get(cacheKey);
  if (cached) return cached;

  const url1qb =
    'https://api.fantasycalc.com/values/current?isDynasty=true&numQbs=1&numTeams=12&ppr=1';
  const urlSf =
    'https://api.fantasycalc.com/values/current?isDynasty=true&numQbs=2&numTeams=12&ppr=1';

  // Fetch both in parallel so we can populate both value fields
  const [oneQbData, sfData] = await Promise.all([
    fetchWithTimeout(url1qb).then((r) => {
      if (!r.ok) throw new Error(`FantasyCalc API returned ${r.status}`);
      return r.json() as Promise<Array<{
        player: { id: number; name: string; position: string; maybeTeam?: string; maybeAge?: number; maybeYoe?: number };
        value: number;
        overallRank: number;
        positionRank: number;
        trend30Day?: number;
        maybeTier?: number;
      }>>;
    }),
    fetchWithTimeout(urlSf).then((r) => {
      if (!r.ok) throw new Error(`FantasyCalc SF API returned ${r.status}`);
      return r.json() as Promise<Array<{
        player: { id: number; name: string };
        value: number;
      }>>;
    }),
  ]);

  // Build SF value lookup by player id
  const sfMap = new Map<number, number>();
  for (const item of sfData) {
    sfMap.set(item.player.id, item.value);
  }

  const results: KTCPlayer[] = oneQbData
    .filter((item) => item.player.position !== 'PICK')
    .map((item) => ({
      playerID: item.player.id,
      playerName: item.player.name,
      position: item.player.position,
      positionRank: item.positionRank,
      team: item.player.maybeTeam ?? '',
      age: item.player.maybeAge ?? 0,
      value: item.value,
      superflexValue: sfMap.get(item.player.id) ?? 0,
      isRookie: item.player.maybeYoe === 0,
      slug: '',
      trend30Day: item.trend30Day ?? 0,
    }));

  // Sort by value descending (1QB value)
  results.sort((a, b) => b.value - a.value);

  fcCache.set(cacheKey, results);
  return results;
}

// --- FantasyCalc API ---

const fantasyCalcCache = new Map<string, FantasyCalcPlayer[]>();

export async function fetchFantasyCalcValues(
  isDynasty: boolean = true,
  numQbs: 1 | 2 = 1,
  numTeams: number = 12,
  ppr: 0 | 0.5 | 1 = 1
): Promise<FantasyCalcPlayer[]> {
  const cacheKey = `${isDynasty}-${numQbs}-${numTeams}-${ppr}`;
  const cached = fantasyCalcCache.get(cacheKey);
  if (cached) return cached;

  // Try pre-fetched data
  const sfx = isDynasty
    ? (numQbs === 2 ? 'dynasty_sf' : 'dynasty_1qb')
    : 'redraft_1qb';
  const preFetched = await tryPreFetched<FantasyCalcPlayer[]>(`fantasycalc_${sfx}.json`);
  if (preFetched && preFetched.length > 0) {
    preFetched.sort((a, b) => b.value - a.value);
    fantasyCalcCache.set(cacheKey, preFetched);
    return preFetched;
  }

  const url = `https://api.fantasycalc.com/values/current?isDynasty=${isDynasty}&numQbs=${numQbs}&numTeams=${numTeams}&ppr=${ppr}`;
  const response = await fetchWithTimeout(url);
  if (!response.ok) {
    throw new Error(`FantasyCalc API returned ${response.status}`);
  }

  const data: FantasyCalcPlayer[] = await response.json();

  // Sort by value descending
  data.sort((a, b) => b.value - a.value);
  fantasyCalcCache.set(cacheKey, data);
  return data;
}

// --- Next Gen Stats ---
// NGS files are .csv.gz on GitHub. Current season uses ngs_{type}.csv.gz (no year).
export async function fetchNextGenStats(
  season: number,
  type: 'passing' | 'rushing' | 'receiving' = 'passing'
): Promise<NextGenStats[]> {
  if (IS_PROD) {
    return fetchCsv<NextGenStats>(nflUrl(`nextgen_stats/ngs_${season}_${type}.csv`));
  }
  // Try year-specific first, then current-season (no year) filename
  const urls = [
    `${NFLVERSE_REMOTE}/nextgen_stats/ngs_${season}_${type}.csv.gz`,
    `${NFLVERSE_REMOTE}/nextgen_stats/ngs_${type}.csv.gz`,
  ];
  for (const url of urls) {
    const cached = csvCache.get(url);
    if (cached) return cached as NextGenStats[];
    const response = await fetchWithTimeout(url, { timeout: LARGE_CSV_TIMEOUT });
    if (!response.ok) continue;
    const buf = await response.arrayBuffer();
    const decompressed = new TextDecoder().decode(
      await new Response(
        new Response(buf).body!.pipeThrough(new DecompressionStream('gzip'))
      ).arrayBuffer()
    );
    const result = Papa.parse<NextGenStats>(decompressed, {
      header: true,
      dynamicTyping: true,
      skipEmptyLines: true,
    });
    csvCache.set(url, result.data as unknown[]);
    return result.data;
  }
  return [];
}

// --- Rosters ---
export async function fetchRosters(season: number): Promise<Roster[]> {
  const rosters = await fetchCsv<Roster>(nflUrl(`rosters/roster_${season}.csv`));
  if (season >= ROSTER_OVERRIDES_2026_SEASON) {
    for (const r of rosters) {
      const nn = r.full_name
        .toLowerCase()
        .replace(/[^a-z ]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      const override = ROSTER_OVERRIDES_2026[nn];
      if (override) r.team = override.team;
    }
  }
  return rosters;
}

// --- Contracts ---
export async function fetchContracts(): Promise<Contract[]> {
  return fetchCsv<Contract>(nflUrl(`contracts/historical_contracts.csv`));
}

// --- Depth Charts ---
export async function fetchDepthCharts(season: number): Promise<DepthChart[]> {
  return fetchCsv<DepthChart>(nflUrl(`depth_charts/depth_charts_${season}.csv`));
}

// --- FTN Charting ---
export async function fetchFTNCharting(season: number): Promise<FTNCharting[]> {
  return fetchCsv<FTNCharting>(nflUrl(`ftn_charting/ftn_charting_${season}.csv`));
}

// --- Trades ---
export async function fetchTrades(): Promise<Trade[]> {
  return fetchCsv<Trade>(nflUrl(`trades/trades.csv`));
}

// --- ESPN QBR ---
export async function fetchQBRSeason(): Promise<QBRSeason[]> {
  return fetchCsv<QBRSeason>(nflUrl(`espn_data/qbr_season_level.csv`));
}

export async function fetchQBRWeek(): Promise<QBRWeek[]> {
  return fetchCsv<QBRWeek>(nflUrl(`espn_data/qbr_week_level.csv`));
}

// --- Draft Prospect Data (JackLich10/nfl-draft-data) ---
const DRAFT_DATA = 'https://raw.githubusercontent.com/JackLich10/nfl-draft-data/main';

export async function fetchDraftProspects(): Promise<DraftProspect[]> {
  return fetchCsv<DraftProspect>(`${DRAFT_DATA}/nfl_draft_prospects.csv`);
}

export async function fetchDraftProfiles(): Promise<DraftProfile[]> {
  return fetchCsv<DraftProfile>(`${DRAFT_DATA}/nfl_draft_profiles.csv`);
}

export async function fetchCollegeStats(): Promise<CollegeStats[]> {
  return fetchCsv<CollegeStats>(`${DRAFT_DATA}/college_statistics.csv`);
}

// College football game results (cfbfastR) — for deriving strength of schedule
export interface CollegeGame {
  game_id: number;
  season: number;
  home_team: string;
  home_conference: string;
  home_points: number;
  away_team: string;
  away_conference: string;
  away_points: number;
}
const CFB_DATA = 'https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/schedules';
export async function fetchCollegeGames(): Promise<CollegeGame[]> {
  return fetchCsv<CollegeGame>(`${CFB_DATA}/cfb_games_info.csv`);
}

export async function fetchCollegeQBR(): Promise<CollegeQBR[]> {
  return fetchCsv<CollegeQBR>(`${DRAFT_DATA}/college_qbr.csv`);
}

// --- CollegeFootballData.com supplement ---
// Pulled by .github/workflows/fetch-cfbd-college.yml and committed to
// public/data/. Backfills historical college stats the JackLich10 source
// is missing (~80% of pre-2017 rookies).

export interface CfbdSpRating {
  rating: number;
  offense_rating?: number | null;
  defense_rating?: number | null;
  sos?: number | null;
  second_order_wins?: number | null;
}

export interface CfbdRecruit {
  stars?: number | null;
  rank?: number | null;
  class_year: number;
  position?: string | null;
  committed_to?: string | null;
  composite_rating?: number | null;
  height?: number | null;
  weight?: number | null;
}

export async function fetchCfbdCollegeStats(): Promise<CollegeStats[]> {
  const data = await tryPreFetched<CollegeStats[]>('cfbd-college-stats.json');
  return data || [];
}

export async function fetchCfbdSpRatings(): Promise<Record<string, CfbdSpRating>> {
  return (await tryPreFetched<Record<string, CfbdSpRating>>('cfbd-sp-ratings.json')) || {};
}

export async function fetchCfbdRecruiting(): Promise<Record<string, CfbdRecruit>> {
  return (await tryPreFetched<Record<string, CfbdRecruit>>('cfbd-recruiting.json')) || {};
}

// --- The Odds API (free tier: 500 credits/month) ---
// Fetches NFL game lines and player props from https://the-odds-api.com

export interface OddsGameLine {
  gameId: string;
  homeTeam: string;
  awayTeam: string;
  commenceTime: string;
  spread: number;       // home spread (negative = home favored)
  totalLine: number;    // over/under
  homeImplied: number;  // derived: (total - spread) / 2
  awayImplied: number;  // derived: (total + spread) / 2
  bookmaker: string;
}

export interface OddsPlayerProp {
  gameId: string;
  playerName: string;
  market: string;       // e.g. 'player_pass_yds', 'player_rush_yds'
  line: number;         // over/under line (e.g. 249.5)
  overPrice: number;    // American odds for over
  underPrice: number;   // American odds for under
  bookmaker: string;
}

export interface OddsTeamImpliedTotal {
  team: string;
  avgImplied: number;
  gameCount: number;
  avgSpread: number;
  avgTotal: number;
}

const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';
const ODDS_SPORT = 'americanfootball_nfl';

// Try to get API key from environment or pre-fetched config
function getOddsApiKey(): string | null {
  // Check for pre-configured key (set via .env or config)
  if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_ODDS_API_KEY) {
    return import.meta.env.VITE_ODDS_API_KEY;
  }
  return null;
}

/**
 * Fetch NFL game lines (spreads + totals) from The Odds API.
 * Returns game lines with derived implied totals per team.
 * Uses ~1-2 credits per call.
 */
export async function fetchOddsGameLines(): Promise<OddsGameLine[]> {
  // Try pre-fetched data first
  const preFetched = await tryPreFetched<OddsGameLine[]>('odds_nfl_lines.json');
  if (preFetched && preFetched.length > 0) return preFetched;

  const apiKey = getOddsApiKey();
  if (!apiKey) return [];

  const url = `${ODDS_API_BASE}/sports/${ODDS_SPORT}/odds?regions=us&markets=spreads,totals&oddsFormat=american&apiKey=${apiKey}`;
  const response = await fetchWithTimeout(url);
  if (!response.ok) return [];

  const data: Array<{
    id: string;
    home_team: string;
    away_team: string;
    commence_time: string;
    bookmakers: Array<{
      key: string;
      markets: Array<{
        key: string;
        outcomes: Array<{ name: string; price: number; point?: number }>;
      }>;
    }>;
  }> = await response.json();

  const lines: OddsGameLine[] = [];
  for (const game of data) {
    // Use first bookmaker with both spreads and totals
    for (const bk of game.bookmakers) {
      const spreadMkt = bk.markets.find((m) => m.key === 'spreads');
      const totalMkt = bk.markets.find((m) => m.key === 'totals');
      if (!spreadMkt || !totalMkt) continue;

      const homeSpreadOutcome = spreadMkt.outcomes.find((o) => o.name === game.home_team);
      const totalOverOutcome = totalMkt.outcomes.find((o) => o.name === 'Over');
      if (!homeSpreadOutcome?.point || !totalOverOutcome?.point) continue;

      const spread = homeSpreadOutcome.point;
      const total = totalOverOutcome.point;
      lines.push({
        gameId: game.id,
        homeTeam: game.home_team,
        awayTeam: game.away_team,
        commenceTime: game.commence_time,
        spread,
        totalLine: total,
        homeImplied: (total - spread) / 2,
        awayImplied: (total + spread) / 2,
        bookmaker: bk.key,
      });
      break; // Only use first valid bookmaker per game
    }
  }

  return lines;
}

/**
 * Aggregate game lines into per-team average implied totals.
 * Useful for projecting team offensive environment.
 */
export function aggregateOddsToTeamImplied(lines: OddsGameLine[]): OddsTeamImpliedTotal[] {
  const teamMap = new Map<string, { implied: number[]; spreads: number[]; totals: number[] }>();

  for (const line of lines) {
    if (!teamMap.has(line.homeTeam)) teamMap.set(line.homeTeam, { implied: [], spreads: [], totals: [] });
    if (!teamMap.has(line.awayTeam)) teamMap.set(line.awayTeam, { implied: [], spreads: [], totals: [] });
    teamMap.get(line.homeTeam)!.implied.push(line.homeImplied);
    teamMap.get(line.homeTeam)!.spreads.push(-line.spread); // negate for home perspective
    teamMap.get(line.homeTeam)!.totals.push(line.totalLine);
    teamMap.get(line.awayTeam)!.implied.push(line.awayImplied);
    teamMap.get(line.awayTeam)!.spreads.push(line.spread);
    teamMap.get(line.awayTeam)!.totals.push(line.totalLine);
  }

  const result: OddsTeamImpliedTotal[] = [];
  for (const [team, data] of teamMap) {
    const avg = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
    result.push({
      team,
      avgImplied: Math.round(avg(data.implied) * 10) / 10,
      gameCount: data.implied.length,
      avgSpread: Math.round(avg(data.spreads) * 10) / 10,
      avgTotal: Math.round(avg(data.totals) * 10) / 10,
    });
  }

  result.sort((a, b) => b.avgImplied - a.avgImplied);
  return result;
}

/**
 * Fetch per-game player props from The Odds API for a specific event.
 * Markets: player_pass_yds, player_rush_yds, player_reception_yds, player_pass_tds, etc.
 * Uses ~1 credit per market per region.
 */
export async function fetchOddsPlayerProps(
  eventId: string,
  markets: string[] = ['player_pass_yds', 'player_rush_yds', 'player_reception_yds']
): Promise<OddsPlayerProp[]> {
  const apiKey = getOddsApiKey();
  if (!apiKey) return [];

  const marketsParam = markets.join(',');
  const url = `${ODDS_API_BASE}/sports/${ODDS_SPORT}/events/${eventId}/odds?regions=us&markets=${marketsParam}&oddsFormat=american&apiKey=${apiKey}`;
  const response = await fetchWithTimeout(url);
  if (!response.ok) return [];

  const data: {
    id: string;
    bookmakers: Array<{
      key: string;
      markets: Array<{
        key: string;
        outcomes: Array<{ name: string; description: string; price: number; point?: number }>;
      }>;
    }>;
  } = await response.json();

  const props: OddsPlayerProp[] = [];
  // Use first bookmaker with each market
  const seenMarkets = new Set<string>();
  for (const bk of data.bookmakers) {
    for (const mkt of bk.markets) {
      if (seenMarkets.has(mkt.key)) continue;
      seenMarkets.add(mkt.key);
      // Props come in pairs (Over/Under) grouped by player description
      const playerLines = new Map<string, { over: number; under: number; line: number }>();
      for (const outcome of mkt.outcomes) {
        const player = outcome.description;
        if (!playerLines.has(player)) playerLines.set(player, { over: 0, under: 0, line: 0 });
        const entry = playerLines.get(player)!;
        if (outcome.name === 'Over') {
          entry.over = outcome.price;
          entry.line = outcome.point || 0;
        } else {
          entry.under = outcome.price;
        }
      }
      for (const [player, entry] of playerLines) {
        props.push({
          gameId: data.id,
          playerName: player,
          market: mkt.key,
          line: entry.line,
          overPrice: entry.over,
          underPrice: entry.under,
          bookmaker: bk.key,
        });
      }
    }
  }

  return props;
}
