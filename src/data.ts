import Papa from 'papaparse';
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

// In production, nflverse CSVs are pre-downloaded into /data/ at build time
// as a flat directory. Locally, fetch directly from GitHub releases.
const IS_PROD = typeof window !== 'undefined' && window.location.hostname !== 'localhost';

/** Build a URL for an nflverse CSV file. In prod, serves from local /data/filename.csv */
function nflUrl(releaseSubpath: string): string {
  if (IS_PROD) {
    // Extract just the filename from paths like "player_stats/player_stats_2024.csv"
    const filename = releaseSubpath.split('/').pop()!;
    return `${import.meta.env.BASE_URL}data/${filename}`;
  }
  return `${NFLVERSE_REMOTE}/${releaseSubpath}`;
}

export async function fetchPlayerStats(season: number): Promise<PlayerStats[]> {
  const url = nflUrl(`player_stats/player_stats_${season}.csv`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch stats for ${season}: ${response.status}`);
  }
  const text = await response.text();
  const result = Papa.parse<PlayerStats>(text, {
    header: true,
    dynamicTyping: true,
    skipEmptyLines: true,
  });
  // Filter to regular season only
  return result.data.filter((row) => row.season_type === 'REG');
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

  const response = await fetch(url);
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
  const response = await fetch(url);
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
  return fetchCsv<FantasyRanking>(`${DYNASTYPROCESS}/db_fpecr_latest.csv`);
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

const ffcAdpCache = new Map<string, FfcADPPlayer[]>();

export async function fetchFfcADP(
  season: number,
  scoring: 'standard' | 'ppr' | 'half-ppr' | '2qb' = 'ppr',
  teams: number = 12
): Promise<FfcADPPlayer[]> {
  const cacheKey = `${season}-${scoring}-${teams}`;
  const cached = ffcAdpCache.get(cacheKey);
  if (cached) return cached;

  const url = `https://fantasyfootballcalculator.com/api/v1/adp/${scoring}?teams=${teams}&year=${season}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`FFC API returned ${response.status}`);
  }

  const json = await response.json();
  const rawPlayers: Array<Record<string, unknown>> = json.players || [];

  const players: FfcADPPlayer[] = rawPlayers.map((p) => ({
    name: String(p.name || ''),
    position: String(p.position || ''),
    team: String(p.team || ''),
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

const espnAdpCache = new Map<number, EspnADPPlayer[]>();

export async function fetchEspnADP(season: number): Promise<EspnADPPlayer[]> {
  const cached = espnAdpCache.get(season);
  if (cached) return cached;

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

  const response = await fetch(url, {
    headers: {
      'x-fantasy-filter': JSON.stringify(filter),
    },
  });

  if (!response.ok) {
    throw new Error(`ESPN API returned ${response.status}`);
  }

  const raw = await response.json();

  // The response can be either an array of player objects directly
  // or an object with a `players` array
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

  // Sort by PPR draft rank
  players.sort((a, b) => (a.draftRankPpr || 999) - (b.draftRankPpr || 999));

  espnAdpCache.set(season, players);
  return players;
}

// --- Sleeper API ---

const SLEEPER = 'https://api.sleeper.app/v1';

let sleeperPlayersCache: Map<string, SleeperPlayer> | null = null;

export async function fetchSleeperPlayers(): Promise<Map<string, SleeperPlayer>> {
  if (sleeperPlayersCache) return sleeperPlayersCache;

  const response = await fetch(`${SLEEPER}/players/nfl`);
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
    fetch(`${SLEEPER}/players/nfl/trending/${type}?lookback_hours=${hours}&limit=${limit}`),
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
    fetch(url),
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

  const allPlayers: KTCPlayer[] = [];
  const formatParam = format === '1qb' ? '1' : '0';

  // KTC paginates across 10 pages
  for (let page = 0; page < 10; page++) {
    const url = `https://keeptradecut.com/dynasty-rankings?page=${page}&filters=QB|WR|RB|TE|RDP&format=${formatParam}`;
    const response = await fetch(url);
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
      for (const p of players) {
        allPlayers.push({
          playerID: Number(p.playerID) || 0,
          playerName: String(p.playerName || ''),
          position: String(p.position || ''),
          positionRank: Number(p.positionRank) || 0,
          team: String(p.team || ''),
          age: Number(p.age) || 0,
          value: Number(p.value) || 0,
          superflexValue: Number(p.superflexValue) || 0,
          isRookie: Boolean(p.isRookie),
          slug: String(p.slug || ''),
        });
      }
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
    const response = await fetch('https://keeptradecut.com/dynasty-rankings/histories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toFetch),
    });

    if (!response.ok) {
      throw new Error(`KTC history API returned ${response.status}`);
    }

    const data: KTCPlayerHistory[] = await response.json();
    for (const entry of data) {
      ktcHistoryCache.set(entry.playerID, entry);
      results.push(entry);
    }
  }

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

  const url = `https://api.fantasycalc.com/values/current?isDynasty=${isDynasty}&numQbs=${numQbs}&numTeams=${numTeams}&ppr=${ppr}`;
  const response = await fetch(url);
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
export async function fetchNextGenStats(
  season: number,
  type: 'passing' | 'rushing' | 'receiving' = 'passing'
): Promise<NextGenStats[]> {
  return fetchCsv<NextGenStats>(nflUrl(`nextgen_stats/ngs_${season}_${type}.csv`));
}

// --- Rosters ---
export async function fetchRosters(season: number): Promise<Roster[]> {
  return fetchCsv<Roster>(nflUrl(`rosters/roster_${season}.csv`));
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

export async function fetchCollegeQBR(): Promise<CollegeQBR[]> {
  return fetchCsv<CollegeQBR>(`${DRAFT_DATA}/college_qbr.csv`);
}
