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
} from './types';

const NFLVERSE =
  'https://github.com/nflverse/nflverse-data/releases/download';
const BASE_URL = `${NFLVERSE}/player_stats`;

export async function fetchPlayerStats(season: number): Promise<PlayerStats[]> {
  const url = `${BASE_URL}/player_stats_${season}.csv`;
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
  return fetchCsv<Game>(`${NFLVERSE}/schedules/games.csv`);
}

// --- Snap Counts ---
export async function fetchSnapCounts(season: number): Promise<SnapCount[]> {
  return fetchCsv<SnapCount>(
    `${NFLVERSE}/snap_counts/snap_counts_${season}.csv`
  );
}

// --- Combine ---
export async function fetchCombine(): Promise<CombineResult[]> {
  return fetchCsv<CombineResult>(`${NFLVERSE}/combine/combine.csv`);
}

// --- Draft Picks ---
export async function fetchDraftPicks(): Promise<DraftPick[]> {
  return fetchCsv<DraftPick>(`${NFLVERSE}/draft_picks/draft_picks.csv`);
}

// --- Injuries ---
export async function fetchInjuries(season: number): Promise<Injury[]> {
  return fetchCsv<Injury>(`${NFLVERSE}/injuries/injuries_${season}.csv`);
}

// --- PFR Advanced Stats ---
export async function fetchAdvancedStats(
  season: number,
  type: 'pass' | 'rush' | 'rec' | 'def' = 'pass'
): Promise<AdvancedStats[]> {
  return fetchCsv<AdvancedStats>(
    `${NFLVERSE}/pfr_advstats/advstats_week_${type}_${season}.csv`
  );
}

// --- Play-by-Play ---
export async function fetchPlayByPlay(season: number): Promise<PlayByPlay[]> {
  const url = `${NFLVERSE}/pbp/play_by_play_${season}.csv`;
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
