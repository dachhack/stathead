export interface PlayerStats {
  player_id: string;
  player_name: string;
  player_display_name: string;
  position: string;
  position_group: string;
  headshot_url: string;
  recent_team: string;
  season: number;
  week: number;
  season_type: string;
  opponent_team: string;
  completions: number;
  attempts: number;
  passing_yards: number;
  passing_tds: number;
  interceptions: number;
  sacks: number;
  sack_yards: number;
  sack_fumbles: number;
  sack_fumbles_lost: number;
  passing_air_yards: number;
  passing_yards_after_catch: number;
  passing_first_downs: number;
  passing_epa: number;
  passing_2pt_conversions: number;
  pacr: number;
  dakota: number;
  carries: number;
  rushing_yards: number;
  rushing_tds: number;
  rushing_fumbles: number;
  rushing_fumbles_lost: number;
  rushing_first_downs: number;
  rushing_epa: number;
  rushing_2pt_conversions: number;
  receptions: number;
  targets: number;
  receiving_yards: number;
  receiving_tds: number;
  receiving_fumbles: number;
  receiving_fumbles_lost: number;
  receiving_air_yards: number;
  receiving_yards_after_catch: number;
  receiving_first_downs: number;
  receiving_epa: number;
  receiving_2pt_conversions: number;
  racr: number;
  target_share: number;
  air_yards_share: number;
  wopr: number;
  special_teams_tds: number;
  fantasy_points: number;
  fantasy_points_ppr: number;
}

export interface SeasonTotals {
  player_id: string;
  player_name: string;
  player_display_name: string;
  position: string;
  headshot_url: string;
  recent_team: string;
  season: number;
  games: number;
  completions: number;
  attempts: number;
  passing_yards: number;
  passing_tds: number;
  interceptions: number;
  carries: number;
  rushing_yards: number;
  rushing_tds: number;
  receptions: number;
  targets: number;
  receiving_yards: number;
  receiving_tds: number;
  fantasy_points: number;
  fantasy_points_ppr: number;
  // Calculated
  fantasy_points_half_ppr: number;
  rushing_fumbles_lost: number;
  receiving_fumbles_lost: number;
  sack_fumbles_lost: number;
  passing_2pt_conversions: number;
  rushing_2pt_conversions: number;
  receiving_2pt_conversions: number;
  special_teams_tds: number;
}

export type ScoringFormat = 'standard' | 'half_ppr' | 'ppr' | 'custom';

export interface ScoringSettings {
  passing_yard: number;
  passing_td: number;
  interception: number;
  rushing_yard: number;
  rushing_td: number;
  receiving_yard: number;
  receiving_td: number;
  reception: number;
  fumble_lost: number;
  two_pt_conversion: number;
  special_teams_td: number;
}

export type SortDirection = 'asc' | 'desc';

export type Tab = 'stats' | 'compare' | 'scoring';
