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

// --- Sleeper API ---
export interface SleeperTrendingPlayer {
  player_id: string;
  count: number;
}

export interface SleeperPlayer {
  player_id: string;
  full_name: string;
  first_name: string;
  last_name: string;
  position: string;
  team: string;
  age: number;
  years_exp: number;
  number: number;
  status: string;
  sport: string;
  fantasy_positions: string[];
  depth_chart_order: number | null;
  search_rank: number | null;
}

export interface SleeperTrendingRow {
  player_id: string;
  full_name: string;
  position: string;
  team: string;
  age: number;
  count: number;
}

export interface SleeperProjection {
  player_id: string;
  full_name: string;
  position: string;
  team: string;
  pts_std: number;
  pts_half_ppr: number;
  pts_ppr: number;
  pass_yd: number;
  pass_td: number;
  pass_int: number;
  rush_yd: number;
  rush_td: number;
  rec: number;
  rec_yd: number;
  rec_td: number;
}

// --- KeepTradeCut ---
export interface KTCPlayer {
  playerID: number;
  playerName: string;
  position: string;
  positionRank: number;
  team: string;
  age: number;
  value: number;
  superflexValue: number;
  isRookie: boolean;
  slug: string;
  trend30Day?: number;
}

export interface KTCHistoryPoint {
  d: string; // date string
  v: number; // value
}

export interface KTCPlayerHistory {
  playerID: number;
  oneQB: { valueHistory: KTCHistoryPoint[] };
  superflex: { valueHistory: KTCHistoryPoint[] };
}

export type Tab =
  | 'home'
  | 'projections'
  | 'scenario-builder'
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
  | 'pbp'
  | 'charts'
  | 'sleeper'
  | 'ktc'
  | 'sportsdata'
  | 'prospects'
  | 'prospects-2027'
  | 'draft-optimizer'
  | 'trade-calc'
  | 'dynasty-forecast'
  | 'model-docs'
  | 'career-backtest'
  | 'zap-compare'
  | 'docs-rookie'
  | 'docs-dynasty'
  | 'docs-season-ppg'
  | 'my-rankings'
  | 'my-prospects'
  | 'data-query';

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

// --- Fantasy Football Calculator ADP ---
export interface FfcADPPlayer {
  name: string;
  position: string;
  team: string;
  adp: number;
  high: number;
  low: number;
  stdev: number;
  timesDrafted: number;
  bye: number;
}

// --- ESPN ADP ---
export interface EspnADPPlayer {
  espnId: number;
  name: string;
  position: string;
  team: string;
  adp: number;          // averageDraftPosition from ownership
  percentOwned: number;
  draftRankStd: number; // ESPN's standard rank
  draftRankPpr: number; // ESPN's PPR rank
  auctionValueStd: number;
  auctionValuePpr: number;
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
  home_coach: string;
  away_coach: string;
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
  // Formation/personnel (from PBP CSV, not always populated)
  offense_formation: string;
  offense_personnel: string;
  defenders_in_box: number;
  number_of_pass_rushers: number;
}

// --- PBP Participation (NGS-sourced per-play participation) ---
export interface PbpParticipation {
  nflverse_game_id: string;
  old_game_id: string;
  play_id: number;
  possession_team: string;
  offense_formation: string;
  offense_personnel: string;
  defenders_in_box: number;
  defense_personnel: string;
  number_of_pass_rushers: number;
  players_on_play: string;
  offense_players: string;
  defense_players: string;
  n_offense: number;
  n_defense: number;
  ngs_air_yards: number;
  time_to_throw: number;
  was_pressure: number;
  route: string;
  defense_man_zone_type: string;
  defense_coverage_type: string;
}

// --- Next Gen Stats ---
export interface NextGenStats {
  season: number;
  season_type: string;
  week: number;
  player_display_name: string;
  player_position: string;
  team_abbr: string;
  player_gsis_id: string;
  player_jersey_number: number;
  // Passing
  avg_time_to_throw: number;
  avg_completed_air_yards: number;
  avg_intended_air_yards: number;
  avg_air_yards_differential: number;
  aggressiveness: number;
  max_completed_air_distance: number;
  avg_air_yards_to_sticks: number;
  attempts: number;
  pass_yards: number;
  pass_touchdowns: number;
  interceptions: number;
  passer_rating: number;
  completions: number;
  completion_percentage: number;
  expected_completion_percentage: number;
  completion_percentage_above_expectation: number;
  // Receiving
  avg_cushion: number;
  avg_separation: number;
  percent_share_of_intended_air_yards: number;
  receptions: number;
  targets: number;
  catch_percentage: number;
  yards: number;
  rec_touchdowns: number;
  avg_yac: number;
  avg_expected_yac: number;
  avg_yac_above_expectation: number;
  // Rushing
  efficiency: number;
  percent_attempts_gte_eight_defenders: number;
  avg_time_to_los: number;
  rush_attempts: number;
  rush_yards: number;
  expected_rush_yards: number;
  rush_yards_over_expected: number;
  avg_rush_yards: number;
  rush_yards_over_expected_per_att: number;
  rush_pct_over_expected: number;
  rush_touchdowns: number;
}

// --- Rosters ---
export interface Roster {
  season: number;
  team: string;
  position: string;
  depth_chart_position: string;
  jersey_number: number;
  status: string;
  full_name: string;
  first_name: string;
  last_name: string;
  birth_date: string;
  height: number;
  weight: number;
  college: string;
  high_school: string;
  gsis_id: string;
  espn_id: number;
  years_exp: number;
  headshot_url: string;
  week: number;
  entry_year: number;
  rookie_year: number;
  draft_club: string;
  draft_number: number;
}

// --- Contracts ---
export interface Contract {
  player: string;
  position: string;
  team: string;
  is_active: boolean;
  year_signed: number;
  years: number;
  value: number;
  apy: number;
  guaranteed: number;
  apy_cap_pct: number;
  inflated_value: number;
  inflated_apy: number;
  inflated_guaranteed: number;
  otc_id: number;
}

// --- Depth Charts ---
export interface DepthChart {
  dt: string;
  team: string;
  player_name: string;
  gsis_id: string;
  pos_grp: string;
  pos_name: string;
  pos_abb: string;
  pos_slot: number;
  pos_rank: number;
}

// --- FTN Charting ---
export interface FTNCharting {
  nflverse_game_id: string;
  season: number;
  week: number;
  nflverse_play_id: number;
  starting_hash: string;
  qb_location: string;
  n_offense_backfield: number;
  is_no_huddle: boolean;
  is_motion: boolean;
  is_play_action: boolean;
  is_screen_pass: boolean;
  is_rpo: boolean;
  is_trick_play: boolean;
  is_qb_out_of_pocket: boolean;
  is_interception_worthy: boolean;
  is_throw_away: boolean;
  read_thrown: string;
  is_catchable_ball: boolean;
  is_contested_ball: boolean;
  is_created_reception: boolean;
  is_drop: boolean;
  is_qb_sneak: boolean;
  n_blitzers: number;
  n_pass_rushers: number;
  is_qb_fault_sack: boolean;
}

// --- FantasyCalc ---
export interface FantasyCalcPlayer {
  player: {
    id: number;
    name: string;
    mflId: string;
    sleeperId: string;
    position: string;
    maybeBirthday: string | null;
    maybeHeight: number | null;
    maybeWeight: number | null;
    maybeCollege: string | null;
    maybeTeam: string | null;
    maybeAge: number | null;
    maybeYoe: number | null;
  };
  value: number;
  overallRank: number;
  positionRank: number;
  trend30Day: number;
  redraftValue: number;
  combinedValue: number;
  redraftDynastyValueDifference: number;
  redraftDynastyValuePercDifference: number;
  displayTrend: string;
  maybeMovingStandardDeviation: number | null;
  starter: boolean;
}

// --- Trades ---
export interface Trade {
  trade_id: number;
  season: number;
  trade_date: string;
  gave: string;
  received: string;
  pick_season: number;
  pick_round: number;
  pick_number: number;
  conditional: number;
  pfr_id: string;
  pfr_name: string;
}

// --- ESPN QBR ---
export interface QBRSeason {
  season: number;
  season_type: string;
  game_week: string;
  team_abb: string;
  player_id: number;
  name_short: string;
  rank: number;
  qbr_total: number;
  pts_added: number;
  qb_plays: number;
  epa_total: number;
  pass: number;
  run: number;
  exp_sack: number;
  penalty: number;
  qbr_raw: number;
  sack: number;
  name_first: string;
  name_last: string;
  name_display: string;
  headshot_href: string;
  team: string;
  qualified: string;
}

export interface QBRWeek {
  season: number;
  season_type: string;
  game_id: string;
  game_week: string;
  week_text: string;
  team_abb: string;
  player_id: number;
  name_short: string;
  rank: number;
  qbr_total: number;
  pts_added: number;
  qb_plays: number;
  epa_total: number;
  pass: number;
  run: number;
  exp_sack: number;
  penalty: number;
  qbr_raw: number;
  sack: number;
  name_first: string;
  name_last: string;
  name_display: string;
  headshot_href: string;
  team: string;
  opp_id: number;
  opp_abb: string;
  opp_team: string;
  opp_name: string;
  week_num: number;
  qualified: string;
}

// --- Draft Prospect Data (JackLich10/nfl-draft-data) ---
export interface DraftProspect {
  draft_year: number;
  player_id: number;
  player_name: string;
  position: string;
  pos_abbr: string;
  school: string;
  school_name: string;
  school_abbr: string;
  pick: number;
  overall: number;
  round: number;
  traded: string;
  team: string;
  team_abbr: string;
  weight: number;
  height: number;
  pos_rk: number;
  ovr_rk: number;
  grade: number;
}

export interface DraftProfile {
  player_id: number;
  player_name: string;
  position: string;
  pos_abbr: string;
  weight: number;
  height: number;
  school: string;
  school_abbr: string;
  school_name: string;
  pos_rk: number;
  ovr_rk: number;
  grade: number;
  text1: string;
  text2: string;
  text3: string;
  text4: string;
}

export interface CollegeStats {
  player_id?: number;
  alt_player_id?: number;
  player_name: string;
  pos_abbr: string;
  school: string;
  school_abbr?: string;
  season: number;
  statistic: string;
  value: number;
}

export interface CollegeQBR {
  season: number;
  guid: string;
  player_name: string;
  age: number;
  total_qbr: number;
  points_added: number;
  qb_plays: number;
  total_epa: number;
  pass: number;
  run: number;
  exp_sack: number;
  penalty: number;
  raw_qbr: number;
  sack: number;
}

// --- SportsDataIO API Types ---

export interface SDIOProjection {
  PlayerID: number;
  Name: string;
  Team: string;
  Position: string;
  FantasyPoints: number;
  FantasyPointsPPR: number;
  PassingAttempts: number;
  PassingCompletions: number;
  PassingYards: number;
  PassingTouchdowns: number;
  PassingInterceptions: number;
  RushingAttempts: number;
  RushingYards: number;
  RushingTouchdowns: number;
  Targets?: number;
  Receptions: number;
  ReceivingYards: number;
  ReceivingTouchdowns: number;
  FumblesLost: number;
  FieldGoalsMade: number;
  ExtraPointsMade: number;
}

export interface SDIODfsSalary {
  PlayerID: number;
  Name: string;
  Team: string;
  Position: string;
  OperatorPlayerID: string;
  OperatorSalary: number;
  OperatorPosition: string;
  OperatorSlateID: number;
  SlateID: number;
  SlateGameID: number;
  Operator: string; // 'FanDuel' | 'DraftKings' | 'Yahoo'
  FantasyPoints: number;
  FantasyPointsPPR: number;
}

export interface SDIOOdds {
  GameId: number;
  Season: number;
  SeasonType: number;
  Week: number;
  HomeTeam: string;
  AwayTeam: string;
  DateTime: string;
  HomeMoneyLine: number;
  AwayMoneyLine: number;
  PointSpread: number;
  OverUnder: number;
  HomePointSpreadPayout: number;
  AwayPointSpreadPayout: number;
  OverPayout: number;
  UnderPayout: number;
  Status: string;
}

export interface SDIONews {
  NewsID: number;
  Source: string;
  Updated: string;
  TimeAgo: string;
  Title: string;
  Content: string;
  Url: string;
  OriginalSource: string;
  OriginalSourceUrl: string;
  PlayerID: number;
  PlayerID2: number;
  Team: string;
  Team2: string;
  Categories: string;
}

export interface SDIOBoxScore {
  Game: {
    GameKey: string;
    Season: number;
    Week: number;
    HomeTeam: string;
    AwayTeam: string;
    HomeScore: number;
    AwayScore: number;
    DateTime: string;
    Status: string;
  };
  PlayerGames: SDIOPlayerGame[];
}

export interface SDIOPlayerGame {
  PlayerID: number;
  Name: string;
  Team: string;
  Position: string;
  PassingAttempts: number;
  PassingCompletions: number;
  PassingYards: number;
  PassingTouchdowns: number;
  PassingInterceptions: number;
  RushingAttempts: number;
  RushingYards: number;
  RushingTouchdowns: number;
  Receptions: number;
  ReceivingYards: number;
  ReceivingTouchdowns: number;
  FumblesLost: number;
  FantasyPoints: number;
  FantasyPointsPPR: number;
  Played: number;
  Started: number;
}

// --- Scenario Builder Types ---

export interface TeamTendency {
  team: string;
  passRatioDelta: number; // -30 to +30, positive = more pass-heavy
}

export interface TeamVolume {
  team: string;
  volumeDelta: number; // percentage change to total team volume, e.g. 10 = +10%
}

export type TeamStatKey =
  | 'PassingAttempts'
  | 'PassingCompletions'
  | 'PassingYards'
  | 'PassingTouchdowns'
  | 'PassingInterceptions'
  | 'RushingAttempts'
  | 'RushingYards'
  | 'RushingTouchdowns'
  | 'Receptions'
  | 'ReceivingYards'
  | 'ReceivingTouchdowns';

export interface TeamStatAdjustment {
  team: string;
  stat: TeamStatKey;
  delta: number; // percentage change, e.g. 10 = +10%
}

export interface VolumeOverride {
  playerId: number;
  playerName: string;
  team: string;
  position: string;
  volumeDelta: number; // percentage change, e.g. 25 = +25%  (overall default)
  // Optional per-stat-pool overrides (when set, override the blanket volumeDelta for that pool)
  rushDelta?: number;   // rush att/yds/td override
  recDelta?: number;    // targets/rec/recYds/recTD override
  passDelta?: number;   // pass att/comp/yds/td/int override (QB only)
}

export interface PlayerMovement {
  playerId: number;
  playerName: string;
  fromTeam: string;
  toTeam: string;
}

// Set a player's projection to an absolute PPR target (e.g. the "Consensus"
// preset blends toward Mike Clay's numbers). Counting stats are scaled by
// target/current so the stat line stays internally consistent. Non-zero-sum.
export interface PointsOverride {
  playerId: number;
  playerName: string;
  team: string;
  position: string;
  ppr: number; // target PPR fantasy points
}

// Set specific absolute counting-stat values for a player (the Roster Editor's
// "Stats" view — edit exact carries/yards/TDs/catches, or a team-pool share %
// that maps to them). Any provided field overrides that stat; omitted fields
// keep the player's projected value. Non-zero-sum; points recompute.
export interface PlayerStatOverride {
  playerId: number;
  playerName: string;
  team: string;
  position: string;
  PassingAttempts?: number;
  PassingCompletions?: number;
  PassingYards?: number;
  PassingTouchdowns?: number;
  PassingInterceptions?: number;
  RushingAttempts?: number;
  RushingYards?: number;
  RushingTouchdowns?: number;
  Targets?: number;
  Receptions?: number;
  ReceivingYards?: number;
  ReceivingTouchdowns?: number;
}

// Per-player games/availability haircut (e.g. "Injury skeptic").
// `games` is projected games played out of 17; counting stats are scaled
// by games/17. Non-zero-sum — lost games are not redistributed to teammates.
export interface PlayerAvailability {
  playerId: number;
  playerName: string;
  team: string;
  position: string;
  games: number; // 1..17 (17 = full season, no haircut)
}

export interface CustomPlayer {
  id: string;
  name: string;
  position: string;
  team: string;
  fantasyPointsPPR: number;
  fantasyPoints: number;
}

// Free agent available for signing — derived from prior season stats
export interface FreeAgentPlayer {
  name: string;
  position: string;
  priorGames: number;
  priorPPR: number;
  passAtt: number;
  passComp: number;
  passYds: number;
  passTD: number;
  int: number;
  rushAtt: number;
  rushYds: number;
  rushTD: number;
  tgt: number;
  rec: number;
  recYds: number;
  recTD: number;
}

// A free agent signed to a specific team in a scenario
export interface FreeAgentSigning {
  id: string;
  name: string;
  position: string;
  toTeam: string;
  priorGames: number;
  priorPPR: number;
  passAtt: number;
  passComp: number;
  passYds: number;
  passTD: number;
  int: number;
  rushAtt: number;
  rushYds: number;
  rushTD: number;
  tgt: number;
  rec: number;
  recYds: number;
  recTD: number;
}

export interface ScenarioConfig {
  id: string;
  name: string;
  vegasWeighting: number; // 0 | 10 | 25 | 50
  teamTendencies: TeamTendency[];
  teamVolumes: TeamVolume[];
  teamStatAdjustments: TeamStatAdjustment[];
  volumeOverrides: VolumeOverride[];
  movements: PlayerMovement[];
  customPlayers: CustomPlayer[];
  freeAgentSignings: FreeAgentSigning[];
  playerAvailability: PlayerAvailability[];
  pointsOverrides: PointsOverride[];
  statOverrides: PlayerStatOverride[];
}
