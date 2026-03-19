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

export type Tab =
  | 'stats'
  | 'compare'
  | 'scoring'
  | 'adp'
  | 'games'
  | 'snaps'
  | 'combine'
  | 'draft'
  | 'injuries'
  | 'advanced'
  | 'pbp';

// --- Fantasy Rankings (FantasyPros ECR / ADP) ---
export interface FantasyRanking {
  page_type: string;
  ecr_type: string;
  player: string;
  id: number;
  pos: string;
  team: string;
  ecr: number;
  sd: number;
  best: number;
  worst: number;
  player_owned_avg: number;
  player_owned_espn: number;
  player_owned_yahoo: number;
  bye: number;
  scrape_date: string;
}

// --- Fantasy Season Results (ADP vs actual finish) ---
export interface FantasySeasonResult {
  player_display_name: string;
  player_id: string;
  position: string;
  team: string;
  headshot_url: string;
  games: number;
  fantasy_points: number;
  fantasy_points_ppr: number;
  fantasy_points_half_ppr: number;
  // Ranks
  overall_rank_std: number;
  overall_rank_ppr: number;
  pos_rank_std: number;
  pos_rank_ppr: number;
  // ADP
  adp_ecr: number | null;
  adp_pos: string | null;
  // Value delta (positive = outperformed ADP, negative = busted)
  adp_delta: number | null;
}

// --- Games / Schedules ---
export interface Game {
  game_id: string;
  season: number;
  game_type: string;
  week: number;
  gameday: string;
  weekday: string;
  gametime: string;
  away_team: string;
  away_score: number;
  home_team: string;
  home_score: number;
  location: string;
  result: number;
  total: number;
  overtime: number;
  spread_line: number;
  total_line: number;
  away_moneyline: number;
  home_moneyline: number;
  away_rest: number;
  home_rest: number;
  div_game: number;
  roof: string;
  surface: string;
  temp: number;
  wind: number;
}

// --- Snap Counts ---
export interface SnapCount {
  game_id: string;
  season: number;
  game_type: string;
  week: number;
  player: string;
  pfr_player_id: string;
  position: string;
  team: string;
  opponent: string;
  offense_snaps: number;
  offense_pct: number;
  defense_snaps: number;
  defense_pct: number;
  st_snaps: number;
  st_pct: number;
}

// --- Combine ---
export interface CombineResult {
  season: number;
  draft_year: number;
  draft_team: string;
  draft_round: number;
  draft_ovr: number;
  pfr_id: string;
  player_name: string;
  pos: string;
  school: string;
  ht: string;
  wt: number;
  forty: number;
  bench: number;
  vertical: number;
  broad_jump: number;
  cone: number;
  shuttle: number;
}

// --- Draft Picks ---
export interface DraftPick {
  season: number;
  round: number;
  pick: number;
  team: string;
  pfr_player_name: string;
  pfr_player_id: string;
  hof: number;
  position: string;
  category: string;
  side: string;
  college: string;
  age: number;
  to: number;
  allpro: number;
  probowls: number;
  seasons_started: number;
  w_av: number;
  car_av: number;
  dr_av: number;
  games: number;
  pass_completions: number;
  pass_attempts: number;
  pass_yards: number;
  pass_tds: number;
  pass_ints: number;
  rush_atts: number;
  rush_yards: number;
  rush_tds: number;
}

// --- Injuries ---
export interface Injury {
  season: number;
  game_type: string;
  team: string;
  week: number;
  gsis_id: string;
  position: string;
  full_name: string;
  report_primary_injury: string;
  report_secondary_injury: string;
  report_status: string;
  practice_primary_injury: string;
  practice_secondary_injury: string;
  practice_status: string;
  date_modified: string;
}

// --- PFR Advanced Stats ---
export interface AdvancedStats {
  game_id: string;
  pfr_game_id: string;
  season: number;
  week: number;
  game_type: string;
  team: string;
  opponent: string;
  pfr_player_name: string;
  pfr_player_id: string;
  // Passing advanced
  passing_drops: number;
  passing_drop_pct: number;
  passing_bad_throws: number;
  passing_bad_throw_pct: number;
  times_sacked: number;
  times_blitzed: number;
  times_hurried: number;
  times_hit: number;
  times_pressured: number;
  times_pressured_pct: number;
  // Receiving advanced
  receiving_drop: number;
  receiving_drop_pct: number;
  // Defensive advanced
  def_times_blitzed: number;
  def_times_hurried: number;
  def_times_hitqb: number;
}

// --- Play-by-Play (subset of key columns) ---
export interface PlayByPlay {
  play_id: number;
  game_id: string;
  home_team: string;
  away_team: string;
  season_type: string;
  week: number;
  posteam: string;
  defteam: string;
  yardline_100: number;
  game_date: string;
  qtr: number;
  down: number;
  ydstogo: number;
  desc: string;
  play_type: string;
  yards_gained: number;
  shotgun: number;
  no_huddle: number;
  qb_dropback: number;
  qb_scramble: number;
  pass_length: string;
  pass_location: string;
  air_yards: number;
  yards_after_catch: number;
  run_location: string;
  run_gap: string;
  ep: number;
  epa: number;
  wp: number;
  wpa: number;
  cp: number;
  cpoe: number;
  posteam_score: number;
  defteam_score: number;
  score_differential: number;
  passer_player_name: string;
  passing_yards: number;
  receiver_player_name: string;
  receiving_yards: number;
  rusher_player_name: string;
  rushing_yards: number;
  touchdown: number;
  pass_touchdown: number;
  rush_touchdown: number;
  interception: number;
  fumble_lost: number;
  sack: number;
  complete_pass: number;
  pass_attempt: number;
  rush_attempt: number;
  first_down_rush: number;
  first_down_pass: number;
  penalty_type: string;
  penalty_yards: number;
  success: number;
  series: number;
  series_result: string;
  drive: number;
  fixed_drive_result: string;
  vegas_wp: number;
  vegas_wpa: number;
  spread_line: number;
  total_line: number;
  xpass: number;
  pass_oe: number;
}
