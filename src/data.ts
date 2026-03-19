import Papa from 'papaparse';
import type { PlayerStats, SeasonTotals } from './types';

const BASE_URL =
  'https://github.com/nflverse/nflverse-data/releases/download/player_stats';

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
