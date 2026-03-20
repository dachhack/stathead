/**
 * metrics.ts — Player-level and team-level NFL analytics metrics.
 *
 * Computes derived metrics from raw nflverse data sources:
 *   - PlayerStats (weekly), SeasonTotals
 *   - PlayByPlay, PbpParticipation
 *   - NextGenStats (passing/rushing/receiving)
 *   - AdvancedStats (PFR)
 *   - FTNCharting
 *   - SnapCounts, Rosters
 *
 * All functions are pure: data in, metrics out.
 */

import type {
  SeasonTotals,
  PlayerStats,
  PlayByPlay,
  PbpParticipation,
  NextGenStats,
  AdvancedStats,
  FTNCharting,
  SnapCount,
  Roster,
  Game,
} from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safe(n: number | null | undefined): number {
  return n != null && isFinite(n) ? n : 0;
}

function ratio(num: number, den: number): number | null {
  return den > 0 ? num / den : null;
}

function pct(num: number, den: number): number | null {
  const r = ratio(num, den);
  return r != null ? r * 100 : null;
}

/** NFL passer rating formula */
function passerRating(
  comp: number,
  att: number,
  yds: number,
  td: number,
  int_: number
): number | null {
  if (att === 0) return null;
  const a = Math.min(Math.max(((comp / att - 0.3) * 5), 0), 2.375);
  const b = Math.min(Math.max(((yds / att - 3) * 0.25), 0), 2.375);
  const c = Math.min(Math.max(((td / att) * 20), 0), 2.375);
  const d = Math.min(Math.max((2.375 - (int_ / att) * 25), 0), 2.375);
  return ((a + b + c + d) / 6) * 100;
}

// ---------------------------------------------------------------------------
// Player Metric Shapes
// ---------------------------------------------------------------------------

export interface QBMetrics {
  player_id: string;
  player_name: string;
  team: string;
  season: number;
  games: number;
  // Volume
  completions: number;
  attempts: number;
  passing_yards: number;
  passing_tds: number;
  interceptions: number;
  sacks: number;
  carries: number;
  rushing_yards: number;
  rushing_tds: number;
  // Efficiency
  comp_pct: number | null;
  yards_per_attempt: number | null;
  adj_yards_per_attempt: number | null; // (yards + 20*TD - 45*INT) / att
  td_pct: number | null;
  int_pct: number | null;
  passer_rating: number | null;
  // EPA
  passing_epa: number;
  rushing_epa: number;
  total_epa: number;
  epa_per_dropback: number | null;
  epa_per_play: number | null;
  // Advanced (PFR)
  pressure_rate: number | null;
  sack_rate: number | null;
  bad_throw_pct: number | null;
  drop_pct: number | null;
  // NGS
  avg_time_to_throw: number | null;
  avg_air_yards: number | null;
  aggressiveness: number | null;
  cpoe: number | null;
  // FTN
  play_action_rate: number | null;
  screen_rate: number | null;
  rpo_rate: number | null;
  // Rushing context
  scramble_rate: number | null;
  designed_rush_rate: number | null;
  // Fantasy
  fantasy_points: number;
  fantasy_points_ppr: number;
  fantasy_ppg: number | null;
}

export interface SkillMetrics {
  player_id: string;
  player_name: string;
  position: string;
  team: string;
  season: number;
  games: number;
  // Snap usage
  snap_pct: number | null;
  total_snaps: number;
  // Rushing volume
  carries: number;
  rushing_yards: number;
  rushing_tds: number;
  // Rushing efficiency
  yards_per_carry: number | null;
  rushing_epa: number;
  rushing_epa_per_att: number | null;
  // Receiving volume
  targets: number;
  receptions: number;
  receiving_yards: number;
  receiving_tds: number;
  // Receiving efficiency
  catch_rate: number | null;
  yards_per_reception: number | null;
  yards_per_target: number | null;
  receiving_epa: number;
  receiving_epa_per_target: number | null;
  // Target profile
  target_share: number | null;
  air_yards_share: number | null;
  wopr: number | null;
  racr: number | null;
  // NGS receiving
  avg_cushion: number | null;
  avg_separation: number | null;
  avg_yac: number | null;
  avg_yac_above_expected: number | null;
  avg_intended_air_yards: number | null;
  // NGS rushing
  rush_yards_over_expected_per_att: number | null;
  pct_8plus_defenders: number | null;
  avg_time_to_los: number | null;
  // YPRR (yards per route run) — requires participation/snap data
  routes_run: number | null;
  yprr: number | null;
  // Opportunity
  touches: number;
  total_yards: number;
  total_tds: number;
  opportunities_per_game: number | null; // (carries + targets) / games
  // PFR advanced
  receiving_drop_rate: number | null;
  // Fantasy
  fantasy_points: number;
  fantasy_points_ppr: number;
  fantasy_ppg: number | null;
  fantasy_ppg_ppr: number | null;
}

export interface TeamMetrics {
  team: string;
  season: number;
  games: number;
  // Scoring
  points_scored: number;
  points_allowed: number;
  point_diff: number;
  ppg: number | null;
  // Offensive volume
  total_plays: number;
  pass_attempts: number;
  rush_attempts: number;
  pass_rate: number | null;
  // Neutral-script pass rate (score diff within 7, Q1-Q3)
  neutral_pass_rate: number | null;
  // Efficiency
  yards_per_play: number | null;
  pass_epa_per_play: number | null;
  rush_epa_per_play: number | null;
  total_epa_per_play: number | null;
  success_rate: number | null;
  // Pace
  plays_per_game: number | null;
  seconds_per_play: number | null;
  // Turnovers
  turnovers: number;
  turnover_rate: number | null;
  // Red zone
  rz_attempts: number;
  rz_tds: number;
  rz_td_rate: number | null;
  // Formation/personnel tendencies (from PBP/participation)
  shotgun_rate: number | null;
  no_huddle_rate: number | null;
  // Pass distribution
  deep_pass_rate: number | null; // air_yards >= 20
  short_pass_rate: number | null; // air_yards < 10
  // Defense
  def_epa_per_play: number | null;
  def_pass_epa_per_play: number | null;
  def_rush_epa_per_play: number | null;
  def_success_rate: number | null;
}

// ---------------------------------------------------------------------------
// Player Metric Computation — QB
// ---------------------------------------------------------------------------

export interface QBInputs {
  seasonTotals: SeasonTotals;
  weeklyStats: PlayerStats[];
  pbp: PlayByPlay[];
  ngsPass?: NextGenStats;
  pfrPass?: AdvancedStats[];
  ftn?: FTNCharting[];
}

export function computeQBMetrics(input: QBInputs): QBMetrics {
  const { seasonTotals: s, weeklyStats, pbp, ngsPass, pfrPass, ftn } = input;
  const pid = s.player_id;
  const name = s.player_display_name ?? s.player_name;

  // Aggregate EPA from weekly stats (more reliable than PBP re-aggregation)
  const passEpa = weeklyStats.reduce((a, w) => a + safe(w.passing_epa), 0);
  const rushEpa = weeklyStats.reduce((a, w) => a + safe(w.rushing_epa), 0);

  // PBP-derived counts
  const dropbacks = pbp.filter(
    (p) => p.passer_player_name === name && p.qb_dropback === 1
  );
  const scrambles = dropbacks.filter((p) => p.qb_scramble === 1);
  const designedRushes = pbp.filter(
    (p) => p.rusher_player_name === name && p.qb_scramble !== 1 && p.rush_attempt === 1
  );

  // PFR advanced aggregation
  let totalPressured = 0;
  let totalPressuredPlays = 0;
  let totalBadThrows = 0;
  let totalBadThrowPlays = 0;
  let totalDrops = 0;
  let totalDropPlays = 0;
  if (pfrPass) {
    for (const w of pfrPass) {
      totalPressured += safe(w.times_pressured);
      totalPressuredPlays += safe(w.times_blitzed) + safe(w.times_hurried) + safe(w.times_hit) > 0 ? 1 : 0;
      totalBadThrows += safe(w.passing_bad_throws);
      totalBadThrowPlays += safe(w.times_sacked) + safe(w.passing_bad_throws); // approx total
      totalDrops += safe(w.passing_drops);
      totalDropPlays += safe(w.passing_drops) + safe(w.passing_bad_throws); // use for denominator
    }
  }

  // FTN charting aggregation
  let paPlays = 0;
  let screenPlays = 0;
  let rpoPlays = 0;
  let ftnTotal = 0;
  if (ftn && ftn.length > 0) {
    ftnTotal = ftn.length;
    for (const f of ftn) {
      if (f.is_play_action) paPlays++;
      if (f.is_screen_pass) screenPlays++;
      if (f.is_rpo) rpoPlays++;
    }
  }

  const att = s.attempts;
  const comp = s.completions;

  return {
    player_id: pid,
    player_name: name,
    team: s.recent_team,
    season: s.season,
    games: s.games,
    // Volume
    completions: comp,
    attempts: att,
    passing_yards: s.passing_yards,
    passing_tds: s.passing_tds,
    interceptions: s.interceptions,
    sacks: weeklyStats.reduce((a, w) => a + safe(w.sacks), 0),
    carries: s.carries,
    rushing_yards: s.rushing_yards,
    rushing_tds: s.rushing_tds,
    // Efficiency
    comp_pct: pct(comp, att),
    yards_per_attempt: ratio(s.passing_yards, att),
    adj_yards_per_attempt: ratio(
      s.passing_yards + 20 * s.passing_tds - 45 * s.interceptions,
      att
    ),
    td_pct: pct(s.passing_tds, att),
    int_pct: pct(s.interceptions, att),
    passer_rating: passerRating(comp, att, s.passing_yards, s.passing_tds, s.interceptions),
    // EPA
    passing_epa: passEpa,
    rushing_epa: rushEpa,
    total_epa: passEpa + rushEpa,
    epa_per_dropback: ratio(passEpa, dropbacks.length),
    epa_per_play: ratio(passEpa + rushEpa, dropbacks.length + designedRushes.length),
    // PFR advanced
    pressure_rate: pfrPass
      ? pct(
          pfrPass.reduce((a, w) => a + safe(w.times_pressured), 0),
          pfrPass.reduce((a, w) => a + safe(w.times_blitzed) + safe(w.times_hurried) + safe(w.times_hit) + safe(w.times_pressured), 0) || att
        )
      : null,
    sack_rate: pct(
      weeklyStats.reduce((a, w) => a + safe(w.sacks), 0),
      att + weeklyStats.reduce((a, w) => a + safe(w.sacks), 0)
    ),
    bad_throw_pct: pfrPass ? ratio(totalBadThrows, att) : null,
    drop_pct: pfrPass ? ratio(totalDrops, att) : null,
    // NGS
    avg_time_to_throw: ngsPass?.avg_time_to_throw ?? null,
    avg_air_yards: ngsPass?.avg_intended_air_yards ?? null,
    aggressiveness: ngsPass?.aggressiveness ?? null,
    cpoe: ngsPass?.completion_percentage_above_expectation ?? null,
    // FTN
    play_action_rate: ftnTotal > 0 ? pct(paPlays, ftnTotal) : null,
    screen_rate: ftnTotal > 0 ? pct(screenPlays, ftnTotal) : null,
    rpo_rate: ftnTotal > 0 ? pct(rpoPlays, ftnTotal) : null,
    // Rushing context
    scramble_rate: dropbacks.length > 0 ? pct(scrambles.length, dropbacks.length) : null,
    designed_rush_rate:
      dropbacks.length + designedRushes.length > 0
        ? pct(designedRushes.length, dropbacks.length + designedRushes.length)
        : null,
    // Fantasy
    fantasy_points: s.fantasy_points,
    fantasy_points_ppr: s.fantasy_points_ppr,
    fantasy_ppg: ratio(s.fantasy_points, s.games),
  };
}

// ---------------------------------------------------------------------------
// Player Metric Computation — Skill positions (RB/WR/TE)
// ---------------------------------------------------------------------------

export interface SkillInputs {
  seasonTotals: SeasonTotals;
  weeklyStats: PlayerStats[];
  snaps: SnapCount[];
  ngsRec?: NextGenStats; // season-level NGS receiving row
  ngsRush?: NextGenStats; // season-level NGS rushing row
  pfrRec?: AdvancedStats[];
  routesRun?: number; // if we can estimate from participation
}

export function computeSkillMetrics(input: SkillInputs): SkillMetrics {
  const { seasonTotals: s, weeklyStats, snaps, ngsRec, ngsRush, pfrRec, routesRun } = input;
  const name = s.player_display_name ?? s.player_name;

  const totalSnaps = snaps.reduce((a, sn) => a + safe(sn.offense_snaps), 0);
  const totalTeamSnaps = snaps.length > 0 ? snaps.reduce((a, sn) => {
    // offense_pct is 0-1 or 0-100 depending on source; normalize
    const snapPct = safe(sn.offense_pct);
    const teamTotal = snapPct > 0 ? safe(sn.offense_snaps) / (snapPct > 1 ? snapPct / 100 : snapPct) : 0;
    return a + teamTotal;
  }, 0) : 0;

  const recEpa = weeklyStats.reduce((a, w) => a + safe(w.receiving_epa), 0);
  const rushEpa = weeklyStats.reduce((a, w) => a + safe(w.rushing_epa), 0);

  const touches = s.carries + s.receptions;
  const totalYards = s.rushing_yards + s.receiving_yards;
  const totalTds = s.rushing_tds + s.receiving_tds;

  // PFR drop rate
  let recDrops = 0;
  if (pfrRec) {
    recDrops = pfrRec.reduce((a, w) => a + safe(w.receiving_drop), 0);
  }

  // WOPR — use last available weekly values (they're cumulative-ish)
  const lastWeek = weeklyStats.length > 0 ? weeklyStats[weeklyStats.length - 1] : null;

  return {
    player_id: s.player_id,
    player_name: name,
    position: s.position,
    team: s.recent_team,
    season: s.season,
    games: s.games,
    // Snaps
    snap_pct: totalTeamSnaps > 0 ? pct(totalSnaps, totalTeamSnaps) : null,
    total_snaps: totalSnaps,
    // Rushing
    carries: s.carries,
    rushing_yards: s.rushing_yards,
    rushing_tds: s.rushing_tds,
    yards_per_carry: ratio(s.rushing_yards, s.carries),
    rushing_epa: rushEpa,
    rushing_epa_per_att: ratio(rushEpa, s.carries),
    // Receiving
    targets: s.targets,
    receptions: s.receptions,
    receiving_yards: s.receiving_yards,
    receiving_tds: s.receiving_tds,
    catch_rate: pct(s.receptions, s.targets),
    yards_per_reception: ratio(s.receiving_yards, s.receptions),
    yards_per_target: ratio(s.receiving_yards, s.targets),
    receiving_epa: recEpa,
    receiving_epa_per_target: ratio(recEpa, s.targets),
    // Target profile
    target_share: lastWeek?.target_share != null ? lastWeek.target_share * 100 : null,
    air_yards_share: lastWeek?.air_yards_share != null ? lastWeek.air_yards_share * 100 : null,
    wopr: lastWeek?.wopr ?? null,
    racr: lastWeek?.racr ?? null,
    // NGS receiving
    avg_cushion: ngsRec?.avg_cushion ?? null,
    avg_separation: ngsRec?.avg_separation ?? null,
    avg_yac: ngsRec?.avg_yac ?? null,
    avg_yac_above_expected: ngsRec?.avg_yac_above_expectation ?? null,
    avg_intended_air_yards: ngsRec?.avg_intended_air_yards ?? null,
    // NGS rushing
    rush_yards_over_expected_per_att: ngsRush?.rush_yards_over_expected_per_att ?? null,
    pct_8plus_defenders: ngsRush?.percent_attempts_gte_eight_defenders != null
      ? ngsRush.percent_attempts_gte_eight_defenders * 100
      : null,
    avg_time_to_los: ngsRush?.avg_time_to_los ?? null,
    // YPRR
    routes_run: routesRun ?? null,
    yprr: routesRun != null && routesRun > 0 ? ratio(s.receiving_yards, routesRun) : null,
    // Opportunity
    touches,
    total_yards: totalYards,
    total_tds: totalTds,
    opportunities_per_game: ratio(s.carries + s.targets, s.games),
    // PFR
    receiving_drop_rate: s.targets > 0 ? pct(recDrops, s.targets) : null,
    // Fantasy
    fantasy_points: s.fantasy_points,
    fantasy_points_ppr: s.fantasy_points_ppr,
    fantasy_ppg: ratio(s.fantasy_points, s.games),
    fantasy_ppg_ppr: ratio(s.fantasy_points_ppr, s.games),
  };
}

// ---------------------------------------------------------------------------
// Team Metric Computation
// ---------------------------------------------------------------------------

export interface TeamInputs {
  team: string;
  season: number;
  games: Game[];
  pbp: PlayByPlay[];
}

export function computeTeamMetrics(input: TeamInputs): TeamMetrics {
  const { team, season, games, pbp } = input;

  // Filter games for this team
  const teamGames = games.filter(
    (g) => (g.home_team === team || g.away_team === team) && g.game_type === 'REG'
  );
  const numGames = teamGames.length;

  // Scoring
  let pointsScored = 0;
  let pointsAllowed = 0;
  for (const g of teamGames) {
    if (g.home_team === team) {
      pointsScored += g.home_score;
      pointsAllowed += g.away_score;
    } else {
      pointsScored += g.away_score;
      pointsAllowed += g.home_score;
    }
  }

  // Offensive plays (this team possessing)
  const offPlays = pbp.filter((p) => p.posteam === team && (p.pass_attempt === 1 || p.rush_attempt === 1));
  const passPlays = offPlays.filter((p) => p.pass_attempt === 1);
  const rushPlays = offPlays.filter((p) => p.rush_attempt === 1);
  const totalPlays = offPlays.length;

  // Neutral script: score diff within 7, Q1-Q3
  const neutralPlays = offPlays.filter(
    (p) => Math.abs(safe(p.score_differential)) <= 7 && p.qtr <= 3
  );
  const neutralPasses = neutralPlays.filter((p) => p.pass_attempt === 1);

  // EPA
  const totalEpa = offPlays.reduce((a, p) => a + safe(p.epa), 0);
  const passEpa = passPlays.reduce((a, p) => a + safe(p.epa), 0);
  const rushEpa = rushPlays.reduce((a, p) => a + safe(p.epa), 0);

  // Success rate
  const successPlays = offPlays.filter((p) => p.success === 1);

  // Turnovers
  const turnovers = offPlays.filter(
    (p) => p.interception === 1 || p.fumble_lost === 1
  ).length;

  // Red zone (yardline_100 <= 20)
  const rzPlays = offPlays.filter((p) => safe(p.yardline_100) <= 20);
  const rzTds = rzPlays.filter((p) => p.touchdown === 1);

  // Formation
  const shotgunPlays = offPlays.filter((p) => p.shotgun === 1);
  const noHuddlePlays = offPlays.filter((p) => p.no_huddle === 1);

  // Pass depth
  const passesWithAir = passPlays.filter((p) => p.air_yards != null);
  const deepPasses = passesWithAir.filter((p) => safe(p.air_yards) >= 20);
  const shortPasses = passesWithAir.filter((p) => safe(p.air_yards) < 10);

  // Yards
  const totalYards = offPlays.reduce((a, p) => a + safe(p.yards_gained), 0);

  // Defensive plays (opponent possessing)
  const defPlays = pbp.filter((p) => p.defteam === team && (p.pass_attempt === 1 || p.rush_attempt === 1));
  const defPassPlays = defPlays.filter((p) => p.pass_attempt === 1);
  const defRushPlays = defPlays.filter((p) => p.rush_attempt === 1);
  const defEpa = defPlays.reduce((a, p) => a + safe(p.epa), 0);
  const defPassEpa = defPassPlays.reduce((a, p) => a + safe(p.epa), 0);
  const defRushEpa = defRushPlays.reduce((a, p) => a + safe(p.epa), 0);
  const defSuccess = defPlays.filter((p) => p.success === 1);

  return {
    team,
    season,
    games: numGames,
    // Scoring
    points_scored: pointsScored,
    points_allowed: pointsAllowed,
    point_diff: pointsScored - pointsAllowed,
    ppg: ratio(pointsScored, numGames),
    // Volume
    total_plays: totalPlays,
    pass_attempts: passPlays.length,
    rush_attempts: rushPlays.length,
    pass_rate: pct(passPlays.length, totalPlays),
    neutral_pass_rate: neutralPlays.length > 0 ? pct(neutralPasses.length, neutralPlays.length) : null,
    // Efficiency
    yards_per_play: ratio(totalYards, totalPlays),
    pass_epa_per_play: ratio(passEpa, passPlays.length),
    rush_epa_per_play: ratio(rushEpa, rushPlays.length),
    total_epa_per_play: ratio(totalEpa, totalPlays),
    success_rate: pct(successPlays.length, totalPlays),
    // Pace
    plays_per_game: ratio(totalPlays, numGames),
    seconds_per_play: null, // requires game clock data not in PBP subset
    // Turnovers
    turnovers,
    turnover_rate: pct(turnovers, totalPlays),
    // Red zone
    rz_attempts: rzPlays.length,
    rz_tds: rzTds.length,
    rz_td_rate: rzPlays.length > 0 ? pct(rzTds.length, rzPlays.length) : null,
    // Formation
    shotgun_rate: pct(shotgunPlays.length, totalPlays),
    no_huddle_rate: pct(noHuddlePlays.length, totalPlays),
    // Pass distribution
    deep_pass_rate: passesWithAir.length > 0 ? pct(deepPasses.length, passesWithAir.length) : null,
    short_pass_rate: passesWithAir.length > 0 ? pct(shortPasses.length, passesWithAir.length) : null,
    // Defense
    def_epa_per_play: ratio(defEpa, defPlays.length),
    def_pass_epa_per_play: ratio(defPassEpa, defPassPlays.length),
    def_rush_epa_per_play: ratio(defRushEpa, defRushPlays.length),
    def_success_rate: defPlays.length > 0 ? pct(defSuccess.length, defPlays.length) : null,
  };
}

// ---------------------------------------------------------------------------
// Route estimation from PBP participation data
// ---------------------------------------------------------------------------

/**
 * Estimates routes run per player from PBP participation data.
 * A "route" is counted when a player is listed on an offensive pass play.
 * Returns a Map of player_gsis_id -> route count.
 */
export function estimateRoutesRun(
  participation: PbpParticipation[],
  pbp: PlayByPlay[]
): Map<string, number> {
  // Build set of pass play IDs
  const passPlayIds = new Set<string>();
  for (const p of pbp) {
    if (p.pass_attempt === 1) {
      passPlayIds.add(`${p.game_id}_${p.play_id}`);
    }
  }

  const routes = new Map<string, number>();
  for (const row of participation) {
    const key = `${row.nflverse_game_id}_${row.play_id}`;
    if (!passPlayIds.has(key)) continue;
    // offense_players is a semicolon-separated list of gsis_ids
    if (!row.offense_players) continue;
    const players = row.offense_players.split(';').map((s) => s.trim()).filter(Boolean);
    for (const pid of players) {
      routes.set(pid, (routes.get(pid) || 0) + 1);
    }
  }
  return routes;
}

// ---------------------------------------------------------------------------
// Batch computation helpers
// ---------------------------------------------------------------------------

/** Get all unique NFL teams from a season's games. */
export function getTeams(games: Game[]): string[] {
  const teams = new Set<string>();
  for (const g of games) {
    if (g.home_team) teams.add(g.home_team);
    if (g.away_team) teams.add(g.away_team);
  }
  return Array.from(teams).sort();
}

/**
 * Compute team metrics for every team in a season.
 */
export function computeAllTeamMetrics(
  season: number,
  games: Game[],
  pbp: PlayByPlay[]
): TeamMetrics[] {
  const regGames = games.filter((g) => g.season === season && g.game_type === 'REG');
  const regPbp = pbp; // already filtered by season at fetch time
  const teams = getTeams(regGames);
  return teams.map((team) =>
    computeTeamMetrics({ team, season, games: regGames, pbp: regPbp })
  );
}

/**
 * Index NGS rows by player gsis_id for quick lookup.
 * NGS data has week-level rows; season-level is week === 0.
 */
export function indexNGSByPlayer(rows: NextGenStats[]): Map<string, NextGenStats> {
  const map = new Map<string, NextGenStats>();
  // Prefer season-level rows (week 0), fall back to last week
  const sorted = [...rows].sort((a, b) => a.week - b.week);
  for (const r of sorted) {
    if (r.week === 0) {
      map.set(r.player_gsis_id, r);
    } else if (!map.has(r.player_gsis_id)) {
      map.set(r.player_gsis_id, r);
    }
  }
  return map;
}

/**
 * Group weekly stats by player_id.
 */
export function groupByPlayer<T extends { player_id?: string }>(
  rows: T[],
  idField: keyof T = 'player_id' as keyof T
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const id = row[idField] as unknown as string;
    if (!id) continue;
    const arr = map.get(id);
    if (arr) arr.push(row);
    else map.set(id, [row]);
  }
  return map;
}

/**
 * Group snap counts by player pfr_player_id.
 */
export function groupSnapsByPlayer(snaps: SnapCount[]): Map<string, SnapCount[]> {
  const map = new Map<string, SnapCount[]>();
  for (const s of snaps) {
    const id = s.pfr_player_id;
    if (!id) continue;
    const arr = map.get(id);
    if (arr) arr.push(s);
    else map.set(id, [s]);
  }
  return map;
}
