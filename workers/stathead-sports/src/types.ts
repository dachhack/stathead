// Shared shapes for the StatHead daily-sport service.
//
// Field names follow the consumer's stat dictionaries exactly (see
// docs/daily-sport-data-response.md): every raw per-game count a scorer reads
// is a key of `stats`, and derived fields (pts for skaters, 1b/tb for hitters,
// ip/qs for pitchers, dd/td) are left to the consumer.

export type Sport = 'nhl' | 'mlb' | 'nba' | 'wnba' | 'mls' | 'epl';
export const SPORTS: Sport[] = ['nhl', 'mlb', 'nba', 'wnba', 'mls', 'epl'];

export type GameStatus = 'pre' | 'live' | 'final' | 'postponed' | 'cancelled';

export interface Game {
  game_id: string;
  /** US Eastern calendar date, YYYY-MM-DD. */
  game_date: string;
  start_utc: string | null;
  home: string;
  away: string;
  status: GameStatus;
  /** Feed clock text (e.g. "12:34" with period), null when not live. */
  clock: string | null;
  period: number | null;
  home_score: number | null;
  away_score: number | null;
  /** StatHead season (see SEASON_RULE in sports/index.ts). */
  season: number;
  /** pre | regular | post | allstar | other */
  game_type: string;
  source: string;
  updated_at: string;
}

export interface Line {
  player_id: string;
  name: string;
  team: string;
  /** Feed position code. */
  pos: string;
  played: boolean;
  stats: Record<string, number>;
  source: string;
}

export interface BoxScore {
  game: Game;
  lines: Line[];
  as_of: string;
  /** Set when a final's lines changed after they were first stored. */
  revised_at: string | null;
}

export interface Player {
  player_id: string;
  full_name: string;
  /** Canonical tricode, '' for a free agent. */
  team: string;
  pos: string;
  eligible: string[];
  jersey: string | null;
  headshot_url: string | null;
  active: boolean;
  /** The sport's own code (O, Q, GTD, IL10, LTIR …) or null when healthy. */
  injury_status: string | null;
  injury_note: string | null;
  /** Seasons of experience, 0 in the first; null only when unknown. */
  exp: number | null;
  debut_season: number | null;
  birth_date: string | null;
  /** Cross-source ids: nhl_id / mlb_id / espn_id / sleeper_id / sportradar_id / rotowire_id … */
  ids: Record<string, string>;
  source: string;
}

export interface SeasonLine {
  player_id: string;
  name: string;
  team: string;
  pos: string;
  season: number;
  gp: number;
  stats: Record<string, number>;
  /** MLB only: games at each fielding position, for eligibility. */
  pos_games?: Record<string, number>;
  source: string;
}

export interface AdpRow {
  player_id: string;
  name: string;
  team: string;
  pos: string;
  /** StatHead ADP: the blend of every source that priced the player. */
  adp: number;
  sources: number;
  /** max minus min across the sources. */
  spread: number;
}

/** One market's draft positions, keyed by the player's name as that market spells it. */
export interface AdpSource {
  provider: string;
  as_of: string;
  rows: Array<{ name: string; team: string | null; pos: string | null; adp: number; ref?: string }>;
}

export interface CrosswalkRow {
  player_id: string;
  full_name: string;
  [id: string]: string | null;
}

export interface TeamInfo {
  /** Canonical tricode. */
  code: string;
  name: string;
  /** Codes other feeds use for the same team. */
  aliases: string[];
}

export interface SeasonCtx {
  /** Finals already materialised for the season (basketball sums box scores into season lines). */
  boxScores: () => Promise<BoxScore[]>;
}

export interface DirectoryHints {
  /** Debut seasons already known from earlier runs, by player_id; saves a bio read per player. */
  debutSeasons?: Record<string, number>;
}

export interface SportAdapter {
  sport: Sport;
  /** StatHead season that `now` falls in. */
  currentSeason(now: Date): number;
  teams(): TeamInfo[] | Promise<TeamInfo[]>;
  schedule(date: string): Promise<Game[]>;
  calendar(season: number): Promise<Game[]>;
  boxScore(gameId: string): Promise<BoxScore | null>;
  directory(season: number, hints?: DirectoryHints): Promise<Player[]>;
  seasonLines(season: number, ctx: SeasonCtx): Promise<SeasonLine[]>;
  adpSources(season: number): Promise<AdpSource[]>;
}
