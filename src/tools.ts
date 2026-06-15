/**
 * Tool definitions for Claude's tool-use API.
 * Each tool maps to a data-fetching function + optional client-side processing.
 */

import type { Tool, ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages';
import {
  fetchPlayerStats, aggregateToSeasonTotals, fetchGames,
  fetchSnapCounts, fetchCombine, fetchDraftPicks, fetchInjuries,
  fetchAdvancedStats, fetchAdvancedStatsSeason, fetchPlayByPlay, fetchFantasyRankings,
  fetchSleeperTrending, fetchSleeperProjections,
  fetchKTCRankingsForDisplay, fetchFfcADP, fetchEspnADP,
  fetchNextGenStats, fetchRosters, fetchContracts,
  fetchDepthCharts, fetchFTNCharting, fetchTrades,
  fetchPbpParticipation,
  fetchQBRSeason, fetchQBRWeek,
  fetchDraftProspects, fetchDraftProfiles,
  fetchCollegeQBR, fetchCfbdCollegeStats,
} from './data';
import type { SeasonTotals } from './types';
import {
  computeQBMetrics, computeSkillMetrics, computeAllTeamMetrics,
  estimateRoutesRun, indexNGSByPlayer, groupByPlayer, groupSnapsByPlayer,
  type QBMetrics, type SkillMetrics,
} from './lib/metrics';

// ── Tool Definitions ──

export const NFL_TOOLS: Tool[] = [
  {
    name: 'get_metadata',
    description:
      'Describe this server\'s capabilities: available tools, data sources, ' +
      'per-source season coverage, and valid enum values (positions, scoring ' +
      'formats, league sizes, ADP sources). Call this FIRST to scope a question ' +
      'correctly — it tells you what seasons/sources/formats are supported so ' +
      'you don\'t have to probe by trial and error. Takes no arguments.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'get_player_season_stats',
    description:
      'Get aggregated season totals for NFL players. Returns rushing, passing, receiving, and fantasy stats. ' +
      'Supports filtering by position (QB, RB, WR, TE) and sorting by any stat column. ' +
      'Use this for questions about player performance, fantasy points, rankings, comparisons.',
    input_schema: {
      type: 'object' as const,
      properties: {
        season: { type: 'number', description: 'NFL season year. Coverage: 1999 to the latest completed season (nflverse).' },
        position: {
          type: 'string',
          description: 'Filter by position: QB, RB, WR, TE, or ALL',
          enum: ['ALL', 'QB', 'RB', 'WR', 'TE'],
        },
        sort_by: {
          type: 'string',
          description: 'Column to sort by (descending). Common: fantasy_points_ppr, rushing_yards, receiving_yards, passing_yards, receptions, targets, carries, rushing_tds, receiving_tds, passing_tds',
        },
        limit: { type: 'number', description: 'Max rows to return (default 30, max 100)' },
        player_name: { type: 'string', description: 'Optional: filter to players whose name contains this string (case-insensitive)' },
        min_games: { type: 'number', description: 'Optional: minimum games played' },
      },
      required: ['season'],
    },
  },
  {
    name: 'get_player_weekly_stats',
    description:
      'Get week-by-week stats for specific player(s) in a season. ' +
      'Use this for game logs, weekly trends, consistency analysis, boom/bust analysis.',
    input_schema: {
      type: 'object' as const,
      properties: {
        season: { type: 'number', description: 'NFL season year' },
        player_name: { type: 'string', description: 'Player name to search for (case-insensitive partial match)' },
        position: { type: 'string', description: 'Filter by position', enum: ['QB', 'RB', 'WR', 'TE'] },
        week_start: { type: 'number', description: 'Start week (inclusive)' },
        week_end: { type: 'number', description: 'End week (inclusive)' },
      },
      required: ['season', 'player_name'],
    },
  },
  {
    name: 'get_games',
    description:
      'Get NFL game results and schedules. Includes scores, spreads, totals, weather, surface. ' +
      'Use for team records, point totals, home/away splits, divisional matchups.',
    input_schema: {
      type: 'object' as const,
      properties: {
        season: { type: 'number', description: 'Filter to specific season' },
        week: { type: 'number', description: 'Filter to specific week' },
        team: { type: 'string', description: 'Filter to games involving this team (abbreviation like KC, SF, BUF)' },
        limit: { type: 'number', description: 'Max rows (default 50)' },
      },
      required: [],
    },
  },
  {
    name: 'get_snap_counts',
    description:
      'Get offensive/defensive snap count percentages by player per week. ' +
      'Use for workload analysis, role changes, snap share trends.',
    input_schema: {
      type: 'object' as const,
      properties: {
        season: { type: 'number', description: 'NFL season year (2012+)' },
        player_name: { type: 'string', description: 'Filter by player name' },
        position: { type: 'string', description: 'Filter by position' },
        team: { type: 'string', description: 'Filter by team abbreviation' },
        limit: { type: 'number', description: 'Max rows (default 50)' },
      },
      required: ['season'],
    },
  },
  {
    name: 'get_combine_results',
    description:
      'Get NFL Combine athletic testing results. Includes 40-yard dash, bench press, vertical jump, ' +
      'broad jump, 3-cone drill, shuttle, height, weight, draft position. ' +
      'Use for athletic profile analysis, draft capital evaluation.',
    input_schema: {
      type: 'object' as const,
      properties: {
        position: { type: 'string', description: 'Filter by position (QB, RB, WR, TE, etc.)' },
        player_name: { type: 'string', description: 'Filter by player name' },
        min_season: { type: 'number', description: 'Earliest draft year to include' },
        max_season: { type: 'number', description: 'Latest draft year to include' },
        sort_by: { type: 'string', description: 'Sort by: forty, bench, vertical, broad_jump, cone, shuttle, wt' },
        limit: { type: 'number', description: 'Max rows (default 30)' },
      },
      required: [],
    },
  },
  {
    name: 'get_draft_picks',
    description:
      'Get historical NFL draft picks with career outcomes. Includes round, pick, team, college, ' +
      'career approximate value (car_av), Pro Bowls, All-Pro selections, Hall of Fame status. ' +
      'Note: career columns (car_av, pro_bowls, etc.) are cumulative and are blank/low for ' +
      'recent draftees who are still active — they populate as careers progress. ' +
      'Use for draft analysis, career success by pick, team drafting history.',
    input_schema: {
      type: 'object' as const,
      properties: {
        season: { type: 'number', description: 'Draft year' },
        team: { type: 'string', description: 'Drafting team abbreviation' },
        position: { type: 'string', description: 'Filter by position' },
        round: { type: 'number', description: 'Filter by draft round' },
        player_name: { type: 'string', description: 'Filter by player name' },
        limit: { type: 'number', description: 'Max rows (default 50)' },
      },
      required: [],
    },
  },
  {
    name: 'get_injuries',
    description:
      'Get weekly injury reports. Includes injury type, practice status, game status. ' +
      'Use for injury impact analysis, availability questions.',
    input_schema: {
      type: 'object' as const,
      properties: {
        season: { type: 'number', description: 'NFL season year (2009+)' },
        player_name: { type: 'string', description: 'Filter by player name' },
        team: { type: 'string', description: 'Filter by team' },
        week: { type: 'number', description: 'Filter by week' },
        status: { type: 'string', description: 'Filter by status: Out, Doubtful, Questionable, Probable' },
        limit: { type: 'number', description: 'Max rows (default 50)' },
      },
      required: ['season'],
    },
  },
  {
    name: 'get_advanced_stats',
    description:
      'Get PFR advanced stats: passing (pressure rate, drop rate, bad throws), ' +
      'rushing (yards before/after contact, broken tackles), receiving (drops, YAC). ' +
      'Use for efficiency and process metrics beyond box score.',
    input_schema: {
      type: 'object' as const,
      properties: {
        season: { type: 'number', description: 'NFL season year. Coverage: 2018–present.' },
        stat_type: {
          type: 'string',
          description: 'Type of advanced stats',
          enum: ['pass', 'rush', 'rec', 'def'],
        },
        season_totals: { type: 'boolean', description: 'Return one row per player of PFR season totals (default true). Set false for per-game rows.' },
        player_name: { type: 'string', description: 'Filter by player name' },
        limit: { type: 'number', description: 'Max rows (default 40)' },
      },
      required: ['season', 'stat_type'],
    },
  },
  {
    name: 'get_play_by_play',
    description:
      'Get play-by-play data with EPA, WPA, win probability, air yards, YAC. ' +
      'Use for situational analysis (red zone, 3rd down, 2-minute drill), play type breakdowns, ' +
      'EPA-based efficiency. WARNING: Large dataset — always filter by player, team, or situation.',
    input_schema: {
      type: 'object' as const,
      properties: {
        season: { type: 'number', description: 'NFL season year' },
        player_name: { type: 'string', description: 'Filter to plays involving this player (passer, rusher, or receiver)' },
        team: { type: 'string', description: 'Filter by team on offense (posteam)' },
        play_type: { type: 'string', description: 'Filter: pass, run, punt, kickoff, field_goal', enum: ['pass', 'run', 'punt', 'kickoff', 'field_goal'] },
        down: { type: 'number', description: 'Filter by down (1-4)' },
        week: { type: 'number', description: 'Filter by week' },
        red_zone: { type: 'boolean', description: 'If true, only plays inside the 20' },
        limit: { type: 'number', description: 'Max rows (default 50, max 200)' },
      },
      required: ['season'],
    },
  },
  {
    name: 'get_fantasy_rankings',
    description:
      'Get Expert Consensus Rankings (ECR) and ADP data. ' +
      'Use for draft strategy, value picks (ECR vs ADP), expert opinion analysis.',
    input_schema: {
      type: 'object' as const,
      properties: {
        position: { type: 'string', description: 'Filter by position' },
        limit: { type: 'number', description: 'Max rows (default 50)' },
      },
      required: [],
    },
  },
  {
    name: 'get_adp',
    description:
      'Get Average Draft Position from community (ffc) or ESPN sources. ' +
      'Use for draft value analysis, comparing ADP across platforms.',
    input_schema: {
      type: 'object' as const,
      properties: {
        source: { type: 'string', description: 'Data source', enum: ['ffc', 'espn'] },
        season: { type: 'number', description: 'Season year. ffc coverage: ~2018–present (older seasons may be unavailable); espn: recent seasons only.' },
        scoring: { type: 'string', description: 'Scoring format (community source only)', enum: ['standard', 'ppr', 'half-ppr'] },
        teams: { type: 'number', description: 'League size, one of 8/10/12/14 (community source only). Default 12.', enum: [8, 10, 12, 14] },
        limit: { type: 'number', description: 'Max rows (default 50)' },
      },
      required: ['source', 'season'],
    },
  },
  {
    name: 'get_sleeper_trending',
    description:
      'Get trending player adds or drops from Sleeper fantasy platform. ' +
      'Shows which players are being most added/dropped across all Sleeper leagues. ' +
      'Use for waiver wire analysis and league-wide sentiment.',
    input_schema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', description: 'Trending adds or drops', enum: ['add', 'drop'] },
        hours: { type: 'number', description: 'Lookback window in hours (default 24)' },
        limit: { type: 'number', description: 'Number of players (default 25)' },
      },
      required: [],
    },
  },
  {
    name: 'get_sleeper_projections',
    description:
      'Get Sleeper season or weekly player projections. ' +
      'Includes projected stats and fantasy points by scoring format.',
    input_schema: {
      type: 'object' as const,
      properties: {
        season: { type: 'number', description: 'NFL season year' },
        week: { type: 'number', description: 'Week number (omit for season-long)' },
        position: { type: 'string', description: 'Filter by position' },
        limit: { type: 'number', description: 'Max rows (default 50)' },
      },
      required: ['season'],
    },
  },
  {
    name: 'get_dynasty_values',
    description:
      "Get StatHead's blended dynasty trade values and rankings — a market-consensus " +
      'valuation rescaled to a common scale (not a raw third-party feed). ' +
      'Includes 1QB and SuperFlex values, position ranks, age. ' +
      'Use for dynasty trade evaluation, roster building, value comparisons.',
    input_schema: {
      type: 'object' as const,
      properties: {
        format: { type: 'string', description: 'Format', enum: ['1qb', 'superflex'] },
        position: { type: 'string', description: 'Filter by position' },
        player_name: { type: 'string', description: 'Filter by player name' },
        limit: { type: 'number', description: 'Max rows (default 50)' },
      },
      required: [],
    },
  },
  {
    name: 'get_next_gen_stats',
    description:
      'Get NFL Next Gen Stats — advanced tracking data powered by AWS. ' +
      'Passing: time to throw, air yards, aggressiveness, completion probability (CPOE). ' +
      'Receiving: separation, cushion, YAC above expectation, target share. ' +
      'Rushing: efficiency, rush yards over expected (RYOE), time to LOS, stacked box rate. ' +
      'Use for elite efficiency analysis beyond box score stats.',
    input_schema: {
      type: 'object' as const,
      properties: {
        season: { type: 'number', description: 'NFL season year (2016+)' },
        stat_type: {
          type: 'string',
          description: 'Type of NGS data',
          enum: ['passing', 'rushing', 'receiving'],
        },
        player_name: { type: 'string', description: 'Filter by player name' },
        team: { type: 'string', description: 'Filter by team abbreviation' },
        week: { type: 'number', description: 'Filter by week (omit for all weeks)' },
        limit: { type: 'number', description: 'Max rows (default 40)' },
      },
      required: ['season', 'stat_type'],
    },
  },
  {
    name: 'get_rosters',
    description:
      'Get NFL team rosters with player details: position, status, height, weight, college, ' +
      'birth date, years of experience, draft info, headshot URL. ' +
      'Use for player biographical info, roster composition, experience levels.',
    input_schema: {
      type: 'object' as const,
      properties: {
        season: { type: 'number', description: 'NFL season year' },
        team: { type: 'string', description: 'Filter by team abbreviation' },
        position: { type: 'string', description: 'Filter by position' },
        player_name: { type: 'string', description: 'Filter by player name' },
        status: { type: 'string', description: 'Filter by status (e.g., ACT, RES, PUP)' },
        limit: { type: 'number', description: 'Max rows (default 53)' },
      },
      required: ['season'],
    },
  },
  {
    name: 'get_contracts',
    description:
      'Get NFL player contract details from OverTheCap. Includes total value, APY, guaranteed money, ' +
      'cap percentage, inflation-adjusted values. ' +
      'Use for salary analysis, team cap situations, player investment vs production.',
    input_schema: {
      type: 'object' as const,
      properties: {
        player_name: { type: 'string', description: 'Filter by player name' },
        position: { type: 'string', description: 'Filter by position' },
        team: { type: 'string', description: 'Filter by team' },
        active_only: { type: 'boolean', description: 'Only show active contracts (default true)' },
        sort_by: { type: 'string', description: 'Sort by: value, apy, guaranteed, apy_cap_pct', enum: ['value', 'apy', 'guaranteed', 'apy_cap_pct'] },
        limit: { type: 'number', description: 'Max rows (default 40)' },
      },
      required: [],
    },
  },
  {
    name: 'get_depth_charts',
    description:
      'Get NFL team depth charts showing starter/backup designations. ' +
      'Shows position rank (1=starter, 2=backup, 3=third string). ' +
      'Use for projecting snap shares, identifying handcuffs, roster battles.',
    input_schema: {
      type: 'object' as const,
      properties: {
        season: { type: 'number', description: 'NFL season year' },
        team: { type: 'string', description: 'Filter by team abbreviation' },
        position: { type: 'string', description: 'Filter by position abbreviation (e.g., RB, WR, QB)' },
        player_name: { type: 'string', description: 'Filter by player name' },
        limit: { type: 'number', description: 'Max rows (default 60)' },
      },
      required: ['season'],
    },
  },
  {
    name: 'get_ftn_charting',
    description:
      'Get FTN play-level charting data (2022+). Includes play-action, RPO, screen pass, ' +
      'motion, blitzers, pass rushers, drops, contested catches, QB pocket movement. ' +
      'Use for scheme analysis, play-calling tendencies, process-over-results evaluation.',
    input_schema: {
      type: 'object' as const,
      properties: {
        season: { type: 'number', description: 'NFL season year (2022+)' },
        week: { type: 'number', description: 'Filter by week' },
        game_id: { type: 'string', description: 'Filter by game ID' },
        limit: { type: 'number', description: 'Max rows (default 100)' },
      },
      required: ['season'],
    },
  },
  {
    name: 'get_trades',
    description:
      'Get historical NFL trades. Shows which teams gave/received players and draft picks, ' +
      'including pick round, number, and conditional status. ' +
      'Use for trade history, draft capital analysis, team-building strategies.',
    input_schema: {
      type: 'object' as const,
      properties: {
        season: { type: 'number', description: 'Filter to trades in this season' },
        team: { type: 'string', description: 'Filter to trades involving this team (gave or received)' },
        player_name: { type: 'string', description: 'Filter by traded player name' },
        limit: { type: 'number', description: 'Max rows (default 50)' },
      },
      required: [],
    },
  },
  {
    name: 'get_player_metrics',
    description:
      'Get a comprehensive analytics profile for a player. Combines weekly stats, play-by-play, ' +
      'NGS tracking data, PFR advanced stats, FTN charting, and snap counts into a single metrics object. ' +
      'QB metrics: comp%, Y/A, AY/A, passer rating, EPA/dropback, CPOE, pressure rate, time to throw, ' +
      'play-action rate, scramble rate, designed rush rate. ' +
      'Skill (RB/WR/TE) metrics: YPC, catch rate, YPRR, target share, WOPR, separation, YAC above expected, ' +
      'RYOE, snap%, opportunity rate, drop rate. ' +
      'Use for in-depth player evaluation, cross-position comparisons, efficiency analysis. ' +
      'Returns one row per player matching the query.',
    input_schema: {
      type: 'object' as const,
      properties: {
        season: { type: 'number', description: 'NFL season year (2016+ for NGS, 2022+ for FTN)' },
        player_name: { type: 'string', description: 'Player name to search for (case-insensitive partial match)' },
        position: { type: 'string', description: 'Filter by position', enum: ['QB', 'RB', 'WR', 'TE'] },
        team: { type: 'string', description: 'Filter by team abbreviation' },
        sort_by: { type: 'string', description: 'Sort by any metric column (descending). Common: fantasy_points_ppr, total_epa, yprr, epa_per_dropback' },
        min_games: { type: 'number', description: 'Minimum games played (default 4)' },
        limit: { type: 'number', description: 'Max players to return (default 20)' },
      },
      required: ['season'],
    },
  },
  {
    name: 'get_qbr',
    description:
      'Get ESPN QBR (Total Quarterback Rating) — a comprehensive QB efficiency metric from ESPN. ' +
      'Season-level or week-by-week data from 2006 onward. Includes QBR total, points added, ' +
      'EPA breakdown (pass, run, expected sack, penalty), and raw QBR. ' +
      'Use for QB evaluation, comparing efficiency across eras, weekly performance tracking.',
    input_schema: {
      type: 'object' as const,
      properties: {
        season: { type: 'number', description: 'Filter to specific season (2006+)' },
        level: {
          type: 'string',
          description: 'Season totals or week-by-week',
          enum: ['season', 'weekly'],
        },
        player_name: { type: 'string', description: 'Filter by player name (case-insensitive partial match)' },
        team: { type: 'string', description: 'Filter by team abbreviation' },
        week: { type: 'number', description: 'Filter by week (weekly level only)' },
        qualified: { type: 'boolean', description: 'Only show qualified QBs (default true)' },
        sort_by: { type: 'string', description: 'Sort by column (descending). Common: qbr_total, pts_added, epa_total' },
        limit: { type: 'number', description: 'Max rows (default 32)' },
      },
      required: ['season'],
    },
  },
  {
    name: 'get_draft_prospect_data',
    description:
      'Get ESPN draft prospect rankings and scouting profiles. Includes ESPN grade, position rank, ' +
      'overall rank, physical measurements, and scouting report text (strengths/weaknesses). ' +
      'Data from 1967-present. Use for prospect evaluation, draft class comparisons, historical draft analysis.',
    input_schema: {
      type: 'object' as const,
      properties: {
        draft_year: { type: 'number', description: 'Filter to specific draft year' },
        position: { type: 'string', description: 'Filter by position abbreviation (QB, RB, WR, TE, etc.)' },
        player_name: { type: 'string', description: 'Filter by player name' },
        school: { type: 'string', description: 'Filter by college/school name' },
        include_scouting: { type: 'boolean', description: 'Include scouting report text from draft profiles (default false)' },
        sort_by: { type: 'string', description: 'Sort by: grade, ovr_rk, pos_rk, overall (descending for grade, ascending for ranks)' },
        limit: { type: 'number', description: 'Max rows (default 50)' },
      },
      required: [],
    },
  },
  {
    name: 'get_college_stats',
    description:
      'Get college football statistics for individual players OR a whole class/cohort. ' +
      'Counting stats (passing, rushing, receiving, tackles, sacks, INTs, etc.) by season. ' +
      'Source: CollegeFootballData (CFBD); coverage 2005–present. ' +
      'For one player, pass player_name. For a cohort (e.g. "all 2023 RBs"), omit ' +
      'player_name and pass season (optionally position/school) and sort_by to rank. ' +
      'Use for evaluating college production, dominator rating, market share analysis.',
    input_schema: {
      type: 'object' as const,
      properties: {
        player_name: { type: 'string', description: 'Filter to one player. Omit for a class/cohort query (then season and/or school is required).' },
        season: { type: 'number', description: 'College season. Required for cohort queries (when player_name is omitted).' },
        position: { type: 'string', description: 'Filter by position abbreviation (e.g. RB, WR, QB)' },
        school: { type: 'string', description: 'Filter by school name/abbreviation' },
        sort_by: { type: 'string', description: 'Stat column to rank a cohort by, descending (e.g. "Rushing Yards", "Receiving Yards", "Receptions", "Passing Yards"). Default: season.' },
        limit: { type: 'number', description: 'Max player-seasons (default 100)' },
      },
      required: [],
    },
  },
  {
    name: 'get_college_qbr',
    description:
      'Get ESPN college QBR ratings for quarterback prospects. Includes total QBR, points added, EPA, ' +
      'and breakdown by pass/run/sack. Coverage: 2004–2020 only (historical; the upstream source is not updated ' +
      'for recent seasons — use get_college_stats for current college production). ' +
      'Use for evaluating college QB efficiency, comparing draft prospect QBs across classes.',
    input_schema: {
      type: 'object' as const,
      properties: {
        season: { type: 'number', description: 'Filter to specific college season (2004+)' },
        player_name: { type: 'string', description: 'Filter by player name' },
        sort_by: { type: 'string', description: 'Sort by: total_qbr, points_added, total_epa' },
        limit: { type: 'number', description: 'Max rows (default 30)' },
      },
      required: [],
    },
  },
  {
    name: 'get_team_metrics',
    description:
      'Get comprehensive team-level analytics for a season. Computed from play-by-play data. ' +
      'Offense: pass rate, neutral-script pass rate, EPA/play (total/pass/rush), success rate, ' +
      'yards/play, red zone TD rate, shotgun rate, deep pass rate, pace. ' +
      'Defense: EPA/play allowed (total/pass/rush), defensive success rate. ' +
      'Context: points scored/allowed, point differential, turnovers. ' +
      'Returns one row per team (32 teams). Use for team evaluation, matchup analysis, scheme identification.',
    input_schema: {
      type: 'object' as const,
      properties: {
        season: { type: 'number', description: 'NFL season year' },
        team: { type: 'string', description: 'Filter to a specific team abbreviation' },
        sort_by: { type: 'string', description: 'Sort by any metric (descending). Common: total_epa_per_play, ppg, success_rate, neutral_pass_rate, def_epa_per_play' },
      },
      required: ['season'],
    },
  },
];

// Inject common output-control params into every data tool's schema, so
// `fields` (column projection) and `format` (table/csv/jsonl) are available
// everywhere without repeating them in each definition. get_metadata returns
// prose, so it's skipped.
const COMMON_OUTPUT_PARAMS = {
  fields: {
    type: 'string',
    description:
      'Comma-separated column names to return (projection), e.g. ' +
      '"player_name,games,fantasy_points_ppr". Omit to return all columns. ' +
      'Unknown names are ignored.',
  },
  output_format: {
    type: 'string',
    description:
      'Output format: "table" (default markdown), "csv", or "jsonl". ' +
      'Use csv/jsonl for compact, token-efficient output on large pulls.',
    enum: ['table', 'csv', 'jsonl'],
  },
} as const;
for (const t of NFL_TOOLS) {
  if (t.name === 'get_metadata') continue;
  const props = t.input_schema.properties as Record<string, unknown>;
  // Non-destructive: never clobber a tool's own param (e.g. get_dynasty_values
  // already has a `format` of its own — different meaning).
  for (const [k, v] of Object.entries(COMMON_OUTPUT_PARAMS)) {
    if (!(k in props)) props[k] = v;
  }
}

// ── Tool Execution ──

type ToolInput = Record<string, unknown>;

// Punctuation-insensitive name match. Sources spell names inconsistently —
// PFR drops apostrophes/periods ("JaMarr Chase", "Amon-Ra St Brown"), others
// keep them ("Ja'Marr Chase", "D.J. Moore"), and generational suffixes vary
// ("Odell Beckham Jr"). Normalize both sides before the substring test.
function normalizeNameForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.'`'']/g, '')          // drop apostrophes/periods
    .replace(/-/g, ' ')                 // hyphen -> space (Amon-Ra)
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '') // drop generational suffixes
    .replace(/\s+/g, ' ')
    .trim();
}

function nameMatch(fullName: string, query: string): boolean {
  return normalizeNameForMatch(fullName).includes(normalizeNameForMatch(query));
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function toMarkdownTable(rows: Record<string, unknown>[], columns?: string[]): string {
  if (rows.length === 0) return '(no results)';

  const cols = columns || Object.keys(rows[0]);
  const header = cols.join(' | ');
  const separator = cols.map(() => '---').join(' | ');
  const body = rows.map((row) =>
    cols.map((col) => {
      const val = row[col];
      if (val == null) return '';
      if (typeof val === 'number') {
        return Number.isInteger(val) ? String(val) : val.toFixed(2);
      }
      return String(val);
    }).join(' | ')
  ).join('\n');

  return `${header}\n${separator}\n${body}`;
}

const fmtCell = (val: unknown): string => {
  if (val == null) return '';
  if (typeof val === 'number') return Number.isInteger(val) ? String(val) : val.toFixed(2);
  return String(val);
};

/** Resolve the effective columns, applying an optional `fields` projection. */
function resolveCols(
  rows: Record<string, unknown>[],
  cols: string[] | undefined,
  fields: unknown,
): string[] {
  const base = cols ?? (rows[0] ? Object.keys(rows[0]) : []);
  if (fields == null || fields === '') return base;
  const want = (Array.isArray(fields) ? fields.map(String) : String(fields).split(','))
    .map((s) => s.trim())
    .filter(Boolean);
  if (want.length === 0) return base;
  const available = new Set(base);
  const chosen = want.filter((w) => available.has(w));
  return chosen.length > 0 ? chosen : base; // ignore an all-miss projection
}

/**
 * Shared output renderer for every tool. Honors two common params:
 *   - `fields`: comma-separated column projection (fewer columns)
 *   - `format`: 'table' (default markdown) | 'csv' | 'jsonl' (compact)
 * CSV/JSONL roughly halve token usage on large pulls.
 */
function renderTable(
  input: ToolInput,
  rows: Record<string, unknown>[],
  cols?: string[],
): string {
  if (rows.length === 0) return '(no results)';
  const effective = resolveCols(rows, cols, input.fields);
  const fmt = String(input.output_format ?? 'table').toLowerCase();
  if (fmt === 'jsonl') {
    return rows
      .map((r) => JSON.stringify(Object.fromEntries(effective.map((c) => [c, r[c] ?? null]))))
      .join('\n');
  }
  if (fmt === 'csv') {
    const esc = (v: unknown): string => {
      const s = fmtCell(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [effective.join(','), ...rows.map((r) => effective.map((c) => esc(r[c])).join(','))].join('\n');
  }
  return toMarkdownTable(rows, effective);
}

function pickColumns(row: Record<string, unknown>, cols: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of cols) {
    if (row[c] !== undefined) out[c] = row[c];
  }
  return out;
}

export async function executeTool(
  name: string,
  input: ToolInput
): Promise<ToolResultBlockParam> {
  try {
    const result = await executeToolInner(name, input);
    return {
      type: 'tool_result',
      tool_use_id: '', // filled by caller
      content: result,
    };
  } catch (err) {
    return {
      type: 'tool_result',
      tool_use_id: '',
      content: `Error: ${err instanceof Error ? err.message : String(err)}`,
      is_error: true,
    };
  }
}

async function executeToolInner(name: string, input: ToolInput): Promise<string> {
  switch (name) {
    case 'get_metadata': {
      const catalog = NFL_TOOLS
        .filter((t) => t.name !== 'get_metadata')
        .map((t) => `- \`${t.name}\` — ${(t.description ?? '').split('. ')[0]}.`)
        .join('\n');
      return [
        '# StatHead MCP — capabilities',
        'NFL fantasy-football analytics. Call this to scope a question before querying.',
        '## Data sources',
        [
          '- **nflverse** — play-by-play, player/weekly stats, rosters, snap counts, injuries, depth charts, draft picks, combine (open data)',
          '- **Next Gen Stats** — advanced tracking metrics',
          '- **Sleeper** — trending adds/drops, projections',
          '- **FantasyFootballCalculator (ffc)** & **ESPN** — ADP',
          '- **KeepTradeCut** & **FantasyCalc** — dynasty/redraft trade values',
          '- **FantasyPros / DynastyProcess** — expert consensus rankings',
          '- **ESPN** — QBR; **FTN** — charting; **OverTheCap** — contracts',
          '- **CollegeFootballData (CFBD)** — college stats & QBR',
        ].join('\n'),
        '## Season coverage (approximate — call a tool to confirm)',
        [
          '- Player & weekly stats, play-by-play, games, rosters: **1999–present**',
          '- Combine: 2000–present · Injuries: 2009–present · Snap counts: 2012–present',
          '- Next Gen Stats: 2016–present · QBR: 2006–present · FTN charting: 2022–present',
          '- FFC ADP: **~2018–present** (older may be unavailable); ESPN ADP: recent seasons',
          '- Dynasty/redraft values (KTC, FantasyCalc), Sleeper trending/projections, expert rankings: **current season only**',
        ].join('\n'),
        '## Enumerations',
        [
          '- positions: `QB`, `RB`, `WR`, `TE` (some tools also accept `ALL`)',
          '- scoring (ffc): `standard`, `ppr`, `half-ppr` · PPR (FantasyCalc): `0`, `0.5`, `1`',
          '- league sizes (teams): `8`, `10`, `12`, `14` (ffc) / `8`, `10`, `12`, `14`, `16` (FantasyCalc)',
          '- ADP sources: `ffc`, `espn` · dynasty formats: `1qb`, `superflex`',
        ].join('\n'),
        '## Output control (all tools except get_metadata)',
        [
          '- `fields`: comma-separated column projection, e.g. "player_name,games,fantasy_points_ppr"',
          '- `output_format`: `table` (default) | `csv` | `jsonl` — use csv/jsonl to roughly halve tokens on large pulls',
        ].join('\n'),
        `## Tools (${NFL_TOOLS.length - 1})`,
        catalog,
      ].join('\n\n');
    }

    case 'get_player_season_stats': {
      const season = input.season as number;
      const position = (input.position as string) || 'ALL';
      const sortBy = (input.sort_by as string) || 'fantasy_points_ppr';
      const limit = clamp((input.limit as number) || 30, 1, 100);
      const playerName = input.player_name as string | undefined;
      const minGames = (input.min_games as number) || 0;

      const raw = await fetchPlayerStats(season);
      let totals = aggregateToSeasonTotals(raw.filter((s) => s.season_type === 'REG'));
      if (position !== 'ALL') totals = totals.filter((p) => p.position === position);
      if (playerName) totals = totals.filter((p) => nameMatch(p.player_display_name, playerName));
      if (minGames) totals = totals.filter((p) => p.games >= minGames);

      const key = sortBy as keyof SeasonTotals;
      totals.sort((a, b) => {
        const va = typeof a[key] === 'number' ? (a[key] as number) : 0;
        const vb = typeof b[key] === 'number' ? (b[key] as number) : 0;
        return vb - va;
      });
      totals = totals.slice(0, limit);

      const cols = [
        'player_display_name', 'position', 'recent_team', 'games',
        ...(position === 'QB' || position === 'ALL'
          ? ['completions', 'attempts', 'passing_yards', 'passing_tds', 'interceptions']
          : []),
        'carries', 'rushing_yards', 'rushing_tds',
        'targets', 'receptions', 'receiving_yards', 'receiving_tds',
        'fantasy_points', 'fantasy_points_ppr',
      ];

      const rows = totals.map((p) => pickColumns(p as unknown as Record<string, unknown>, cols));
      return `${season} season stats (${totals.length} players, sorted by ${sortBy}):\n\n${renderTable(input,rows, cols)}`;
    }

    case 'get_player_weekly_stats': {
      const season = input.season as number;
      const playerName = input.player_name as string;
      const position = input.position as string | undefined;
      const weekStart = (input.week_start as number) || 1;
      const weekEnd = (input.week_end as number) || 18;

      const raw = await fetchPlayerStats(season);
      let filtered = raw.filter(
        (s) => s.season_type === 'REG' && nameMatch(s.player_display_name, playerName)
          && s.week >= weekStart && s.week <= weekEnd
      );
      if (position) filtered = filtered.filter((s) => s.position === position);
      filtered.sort((a, b) => a.week - b.week);

      if (filtered.length === 0) return `No weekly stats found for "${playerName}" in ${season}.`;

      const cols = [
        'player_display_name', 'week', 'opponent_team', 'position',
        'completions', 'attempts', 'passing_yards', 'passing_tds', 'interceptions',
        'carries', 'rushing_yards', 'rushing_tds',
        'targets', 'receptions', 'receiving_yards', 'receiving_tds',
        'fantasy_points', 'fantasy_points_ppr',
      ];

      const rows = filtered.map((p) => pickColumns(p as unknown as Record<string, unknown>, cols));
      return `Weekly stats for "${playerName}" in ${season} (weeks ${weekStart}-${weekEnd}):\n\n${renderTable(input,rows, cols)}`;
    }

    case 'get_games': {
      const season = input.season as number | undefined;
      const week = input.week as number | undefined;
      const team = input.team as string | undefined;
      const limit = clamp((input.limit as number) || 50, 1, 200);

      let games = await fetchGames();
      if (season) games = games.filter((g) => g.season === season);
      if (week) games = games.filter((g) => g.week === week);
      if (team) games = games.filter((g) =>
        g.home_team === team.toUpperCase() || g.away_team === team.toUpperCase()
      );
      games = games.slice(-limit); // most recent

      const cols = [
        'season', 'week', 'game_type', 'away_team', 'away_score',
        'home_team', 'home_score', 'result', 'total', 'spread_line', 'total_line',
      ];
      const rows = games.map((g) => pickColumns(g as unknown as Record<string, unknown>, cols));
      return `Games (${games.length} results):\n\n${renderTable(input,rows, cols)}`;
    }

    case 'get_snap_counts': {
      const season = input.season as number;
      const playerName = input.player_name as string | undefined;
      const position = input.position as string | undefined;
      const team = input.team as string | undefined;
      const limit = clamp((input.limit as number) || 50, 1, 200);

      let snaps = await fetchSnapCounts(season);
      if (playerName) snaps = snaps.filter((s) => nameMatch(s.player, playerName));
      if (position) snaps = snaps.filter((s) => s.position === position);
      if (team) snaps = snaps.filter((s) => s.team === team.toUpperCase());
      snaps = snaps.slice(0, limit);

      const cols = ['player', 'position', 'team', 'week', 'opponent', 'offense_snaps', 'offense_pct', 'defense_snaps', 'defense_pct'];
      const rows = snaps.map((s) => pickColumns(s as unknown as Record<string, unknown>, cols));
      return `Snap counts for ${season} (${snaps.length} entries):\n\n${renderTable(input,rows, cols)}`;
    }

    case 'get_combine_results': {
      const position = input.position as string | undefined;
      const playerName = input.player_name as string | undefined;
      const minSeason = input.min_season as number | undefined;
      const maxSeason = input.max_season as number | undefined;
      const sortBy = input.sort_by as string | undefined;
      const limit = clamp((input.limit as number) || 30, 1, 100);

      let combine = await fetchCombine();
      if (position) combine = combine.filter((c) => c.pos === position.toUpperCase());
      if (playerName) combine = combine.filter((c) => nameMatch(c.player_name, playerName));
      if (minSeason) combine = combine.filter((c) => c.season >= minSeason);
      if (maxSeason) combine = combine.filter((c) => c.season <= maxSeason);

      if (sortBy) {
        const key = sortBy as keyof typeof combine[0];
        const ascending = sortBy === 'forty' || sortBy === 'cone' || sortBy === 'shuttle';
        combine.sort((a, b) => {
          const va = typeof a[key] === 'number' ? (a[key] as number) : (ascending ? 999 : 0);
          const vb = typeof b[key] === 'number' ? (b[key] as number) : (ascending ? 999 : 0);
          return ascending ? va - vb : vb - va;
        });
      }
      combine = combine.slice(0, limit);

      const cols = ['season', 'player_name', 'pos', 'school', 'ht', 'wt', 'forty', 'bench', 'vertical', 'broad_jump', 'cone', 'shuttle', 'draft_round', 'draft_ovr'];
      const rows = combine.map((c) => pickColumns(c as unknown as Record<string, unknown>, cols));
      return `Combine results (${combine.length} players):\n\n${renderTable(input,rows, cols)}`;
    }

    case 'get_draft_picks': {
      const season = input.season as number | undefined;
      const team = input.team as string | undefined;
      const position = input.position as string | undefined;
      const round = input.round as number | undefined;
      const playerName = input.player_name as string | undefined;
      const limit = clamp((input.limit as number) || 50, 1, 200);

      let picks = await fetchDraftPicks();
      if (season) picks = picks.filter((p) => p.season === season);
      if (team) picks = picks.filter((p) => p.team === team.toUpperCase());
      if (position) picks = picks.filter((p) => p.position === position.toUpperCase());
      if (round) picks = picks.filter((p) => p.round === round);
      if (playerName) picks = picks.filter((p) => nameMatch(p.pfr_player_name, playerName));
      picks = picks.slice(0, limit);

      const cols = ['season', 'round', 'pick', 'team', 'pfr_player_name', 'position', 'college', 'age', 'games', 'car_av', 'probowls', 'allpro'];
      const rows = picks.map((p) => pickColumns(p as unknown as Record<string, unknown>, cols));
      return `Draft picks (${picks.length} entries):\n\n${renderTable(input,rows, cols)}`;
    }

    case 'get_injuries': {
      const season = input.season as number;
      const playerName = input.player_name as string | undefined;
      const team = input.team as string | undefined;
      const week = input.week as number | undefined;
      const status = input.status as string | undefined;
      const limit = clamp((input.limit as number) || 50, 1, 200);

      let injuries = await fetchInjuries(season);
      if (playerName) injuries = injuries.filter((i) => nameMatch(i.full_name, playerName));
      if (team) injuries = injuries.filter((i) => i.team === team.toUpperCase());
      if (week) injuries = injuries.filter((i) => i.week === week);
      if (status) injuries = injuries.filter((i) => i.report_status === status);
      injuries = injuries.slice(0, limit);

      const cols = ['week', 'full_name', 'position', 'team', 'report_primary_injury', 'report_status', 'practice_status'];
      const rows = injuries.map((i) => pickColumns(i as unknown as Record<string, unknown>, cols));
      return `Injury reports for ${season} (${injuries.length} entries):\n\n${renderTable(input,rows, cols)}`;
    }

    case 'get_advanced_stats': {
      const season = input.season as number;
      const statType = input.stat_type as 'pass' | 'rush' | 'rec' | 'def';
      const playerName = input.player_name as string | undefined;
      const seasonTotals = input.season_totals !== false; // default: season aggregates
      const limit = clamp((input.limit as number) || 40, 1, 100);

      let stats = seasonTotals
        ? await fetchAdvancedStatsSeason(season, statType)
        : await fetchAdvancedStats(season, statType);
      if (playerName) {
        stats = stats.filter((s) => {
          const r = s as unknown as Record<string, unknown>;
          // season files use `player`; weekly files use `pfr_player_name`.
          const nm = (r.pfr_player_name ?? r.player ?? '') as string;
          return nameMatch(nm, playerName);
        });
      }
      stats = stats.slice(0, limit);

      const rows = stats as unknown as Record<string, unknown>[];
      const mode = seasonTotals ? 'season totals' : 'per-game';
      return `Advanced ${statType} stats for ${season} (${mode}, ${stats.length} entries):\n\n${renderTable(input,rows)}`;
    }

    case 'get_play_by_play': {
      const season = input.season as number;
      const playerName = input.player_name as string | undefined;
      const team = input.team as string | undefined;
      const playType = input.play_type as string | undefined;
      const down = input.down as number | undefined;
      const week = input.week as number | undefined;
      const redZone = input.red_zone as boolean | undefined;
      const limit = clamp((input.limit as number) || 50, 1, 200);

      let plays = await fetchPlayByPlay(season);
      if (playerName) {
        const q = playerName.toLowerCase();
        plays = plays.filter((p) =>
          (p.passer_player_name || '').toLowerCase().includes(q) ||
          (p.rusher_player_name || '').toLowerCase().includes(q) ||
          (p.receiver_player_name || '').toLowerCase().includes(q)
        );
      }
      if (team) plays = plays.filter((p) => p.posteam === team.toUpperCase());
      if (playType) plays = plays.filter((p) => p.play_type === playType);
      if (down) plays = plays.filter((p) => p.down === down);
      if (week) plays = plays.filter((p) => p.week === week);
      if (redZone) plays = plays.filter((p) => p.yardline_100 <= 20);
      plays = plays.slice(0, limit);

      const cols = [
        'game_id', 'week', 'qtr', 'down', 'ydstogo', 'yardline_100',
        'posteam', 'defteam', 'play_type', 'yards_gained',
        'epa', 'wpa', 'wp',
        'passer_player_name', 'rusher_player_name', 'receiver_player_name',
        'air_yards', 'yards_after_catch', 'pass_location',
      ];
      const rows = plays.map((p) => pickColumns(p as unknown as Record<string, unknown>, cols));
      return `Play-by-play for ${season} (${plays.length} plays):\n\n${renderTable(input,rows, cols)}`;
    }

    case 'get_fantasy_rankings': {
      const position = input.position as string | undefined;
      const limit = clamp((input.limit as number) || 50, 1, 200);

      let rankings = await fetchFantasyRankings();
      if (position) rankings = rankings.filter((r) => r.pos === position.toUpperCase());
      rankings = rankings.slice(0, limit);

      const cols = ['player', 'pos', 'team', 'ecr', 'sd', 'best', 'worst', 'player_owned_avg', 'page_type'];
      const rows = rankings.map((r) => pickColumns(r as unknown as Record<string, unknown>, cols));
      return `Fantasy rankings (${rankings.length} players):\n\n${renderTable(input,rows, cols)}`;
    }

    case 'get_adp': {
      const source = input.source as 'ffc' | 'espn';
      const season = input.season as number;
      const limit = clamp((input.limit as number) || 50, 1, 200);

      if (source === 'ffc') {
        const scoring = ((input.scoring as string) || 'ppr') as 'standard' | 'ppr' | 'half-ppr';
        const teams = (input.teams as number) || 12;
        let data = await fetchFfcADP(season, scoring, teams);
        data = data.slice(0, limit);
        const rows = data as unknown as Record<string, unknown>[];
        return `Community ADP for ${season} (${scoring}, ${teams}-team, ${data.length} players):\n\n${renderTable(input,rows)}`;
      } else {
        let data = await fetchEspnADP(season);
        data = data.slice(0, limit);
        const rows = data as unknown as Record<string, unknown>[];
        return `ESPN ADP for ${season} (${data.length} players):\n\n${renderTable(input,rows)}`;
      }
    }

    case 'get_sleeper_trending': {
      const type = (input.type as 'add' | 'drop') || 'add';
      const hours = (input.hours as number) || 24;
      const limit = clamp((input.limit as number) || 25, 1, 50);

      const data = await fetchSleeperTrending(type, hours, limit);
      const cols = ['full_name', 'position', 'team', 'age', 'count'];
      const rows = data.map((d) => pickColumns(d as unknown as Record<string, unknown>, cols));
      return `Sleeper trending ${type}s (last ${hours}h, ${data.length} players):\n\n${renderTable(input,rows, cols)}`;
    }

    case 'get_sleeper_projections': {
      const season = input.season as number;
      const week = input.week as number | undefined;
      const position = input.position as string | undefined;
      const limit = clamp((input.limit as number) || 50, 1, 200);

      let data = await fetchSleeperProjections(season, week);
      if (position) data = data.filter((d) => d.position === position.toUpperCase());
      data = data.slice(0, limit);

      const cols = ['full_name', 'position', 'team', 'pts_std', 'pts_half_ppr', 'pts_ppr',
        'pass_yd', 'pass_td', 'pass_int', 'rush_yd', 'rush_td', 'rec', 'rec_yd', 'rec_td'];
      const rows = data.map((d) => pickColumns(d as unknown as Record<string, unknown>, cols));
      return `Sleeper projections for ${season}${week ? ` week ${week}` : ''} (${data.length} players):\n\n${renderTable(input,rows, cols)}`;
    }

    case 'get_dynasty_values': {
      const format = (input.format as '1qb' | 'superflex') || '1qb';
      const position = input.position as string | undefined;
      const playerName = input.player_name as string | undefined;
      const limit = clamp((input.limit as number) || 50, 1, 200);

      // StatHead's blended dynasty value (market consensus rescaled to a
      // common scale) — the same canonical value the website shows, not a
      // raw third-party feed.
      let data = await fetchKTCRankingsForDisplay(format);
      if (position) data = data.filter((d) => d.position === position.toUpperCase());
      if (playerName) data = data.filter((d) => nameMatch(d.playerName, playerName));
      data = data.slice(0, limit);

      const cols = ['playerName', 'position', 'positionRank', 'team', 'age', 'value', 'superflexValue', 'isRookie'];
      const rows = data.map((d) => pickColumns(d as unknown as Record<string, unknown>, cols));
      return `StatHead dynasty values (${format}, ${data.length} players):\n\n${renderTable(input,rows, cols)}`;
    }

    case 'get_next_gen_stats': {
      const season = input.season as number;
      const statType = input.stat_type as 'passing' | 'rushing' | 'receiving';
      const playerName = input.player_name as string | undefined;
      const team = input.team as string | undefined;
      const week = input.week as number | undefined;
      const limit = clamp((input.limit as number) || 40, 1, 100);

      let stats = await fetchNextGenStats(season, statType);
      if (playerName) stats = stats.filter((s) => nameMatch(s.player_display_name, playerName));
      if (team) stats = stats.filter((s) => s.team_abbr === team.toUpperCase());
      if (week) stats = stats.filter((s) => s.week === week);
      stats = stats.slice(0, limit);

      const baseCols = ['player_display_name', 'player_position', 'team_abbr', 'week'];
      const typeCols: Record<string, string[]> = {
        passing: ['avg_time_to_throw', 'avg_completed_air_yards', 'avg_intended_air_yards', 'aggressiveness',
          'completion_percentage', 'expected_completion_percentage', 'completion_percentage_above_expectation',
          'attempts', 'pass_yards', 'pass_touchdowns', 'interceptions', 'passer_rating'],
        receiving: ['avg_cushion', 'avg_separation', 'percent_share_of_intended_air_yards',
          'targets', 'receptions', 'catch_percentage', 'yards', 'rec_touchdowns',
          'avg_yac', 'avg_expected_yac', 'avg_yac_above_expectation'],
        rushing: ['efficiency', 'percent_attempts_gte_eight_defenders', 'avg_time_to_los',
          'rush_attempts', 'rush_yards', 'expected_rush_yards', 'rush_yards_over_expected',
          'rush_yards_over_expected_per_att', 'rush_touchdowns'],
      };
      const cols = [...baseCols, ...typeCols[statType]];
      const rows = stats.map((s) => pickColumns(s as unknown as Record<string, unknown>, cols));
      return `Next Gen Stats ${statType} for ${season} (${stats.length} entries):\n\n${renderTable(input,rows, cols)}`;
    }

    case 'get_rosters': {
      const season = input.season as number;
      const team = input.team as string | undefined;
      const position = input.position as string | undefined;
      const playerName = input.player_name as string | undefined;
      const status = input.status as string | undefined;
      const limit = clamp((input.limit as number) || 53, 1, 200);

      let rosters = await fetchRosters(season);
      if (team) rosters = rosters.filter((r) => r.team === team.toUpperCase());
      if (position) rosters = rosters.filter((r) => r.position === position.toUpperCase());
      if (playerName) rosters = rosters.filter((r) => nameMatch(r.full_name, playerName));
      if (status) rosters = rosters.filter((r) => r.status === status.toUpperCase());
      rosters = rosters.slice(0, limit);

      const cols = ['full_name', 'position', 'team', 'jersey_number', 'status', 'height', 'weight',
        'college', 'birth_date', 'years_exp', 'draft_club', 'draft_number'];
      const rows = rosters.map((r) => pickColumns(r as unknown as Record<string, unknown>, cols));
      return `Rosters for ${season} (${rosters.length} players):\n\n${renderTable(input,rows, cols)}`;
    }

    case 'get_contracts': {
      const playerName = input.player_name as string | undefined;
      const position = input.position as string | undefined;
      const team = input.team as string | undefined;
      const activeOnly = input.active_only !== false;
      const sortBy = (input.sort_by as string) || 'apy';
      const limit = clamp((input.limit as number) || 40, 1, 200);

      let contracts = await fetchContracts();
      if (activeOnly) contracts = contracts.filter((c) => c.is_active);
      if (playerName) contracts = contracts.filter((c) => nameMatch(c.player, playerName));
      if (position) contracts = contracts.filter((c) => c.position === position.toUpperCase());
      if (team) contracts = contracts.filter((c) => c.team === team.toUpperCase());

      const key = sortBy as keyof typeof contracts[0];
      contracts.sort((a, b) => {
        const va = typeof a[key] === 'number' ? (a[key] as number) : 0;
        const vb = typeof b[key] === 'number' ? (b[key] as number) : 0;
        return vb - va;
      });
      contracts = contracts.slice(0, limit);

      const cols = ['player', 'position', 'team', 'year_signed', 'years', 'value', 'apy', 'guaranteed', 'apy_cap_pct', 'inflated_apy'];
      const rows = contracts.map((c) => pickColumns(c as unknown as Record<string, unknown>, cols));
      return `Contracts (${contracts.length} entries, sorted by ${sortBy}):\n\n${renderTable(input,rows, cols)}`;
    }

    case 'get_depth_charts': {
      const season = input.season as number;
      const team = input.team as string | undefined;
      const position = input.position as string | undefined;
      const playerName = input.player_name as string | undefined;
      const limit = clamp((input.limit as number) || 60, 1, 200);

      let charts = await fetchDepthCharts(season);
      if (team) charts = charts.filter((c) => c.team === team.toUpperCase());
      if (position) charts = charts.filter((c) => c.pos_abb === position.toUpperCase());
      if (playerName) charts = charts.filter((c) => nameMatch(c.player_name, playerName));
      // Get most recent snapshot per team
      charts.sort((a, b) => b.dt.localeCompare(a.dt));
      // Deduplicate: keep first occurrence per team/position/rank
      const seen = new Set<string>();
      charts = charts.filter((c) => {
        const key = `${c.team}-${c.pos_abb}-${c.pos_rank}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      charts.sort((a, b) => a.pos_rank - b.pos_rank || a.team.localeCompare(b.team));
      charts = charts.slice(0, limit);

      const cols = ['team', 'player_name', 'pos_abb', 'pos_rank', 'pos_grp'];
      const rows = charts.map((c) => pickColumns(c as unknown as Record<string, unknown>, cols));
      return `Depth charts for ${season} (${charts.length} entries, rank 1=starter):\n\n${renderTable(input,rows, cols)}`;
    }

    case 'get_ftn_charting': {
      const season = input.season as number;
      const week = input.week as number | undefined;
      const gameId = input.game_id as string | undefined;
      const limit = clamp((input.limit as number) || 100, 1, 500);

      let plays = await fetchFTNCharting(season);
      if (week) plays = plays.filter((p) => p.week === week);
      if (gameId) plays = plays.filter((p) => p.nflverse_game_id === gameId);
      plays = plays.slice(0, limit);

      const cols = ['nflverse_game_id', 'week', 'nflverse_play_id',
        'qb_location', 'n_offense_backfield', 'is_no_huddle', 'is_motion',
        'is_play_action', 'is_screen_pass', 'is_rpo', 'is_trick_play',
        'is_qb_out_of_pocket', 'is_interception_worthy', 'is_drop',
        'n_blitzers', 'n_pass_rushers', 'is_qb_fault_sack'];
      const rows = plays.map((p) => pickColumns(p as unknown as Record<string, unknown>, cols));
      return `FTN charting for ${season}${week ? ` week ${week}` : ''} (${plays.length} plays):\n\n${renderTable(input,rows, cols)}`;
    }

    case 'get_trades': {
      const season = input.season as number | undefined;
      const team = input.team as string | undefined;
      const playerName = input.player_name as string | undefined;
      const limit = clamp((input.limit as number) || 50, 1, 200);

      let trades = await fetchTrades();
      if (season) trades = trades.filter((t) => t.season === season);
      if (team) {
        const t = team.toUpperCase();
        trades = trades.filter((tr) => tr.gave === t || tr.received === t);
      }
      if (playerName) trades = trades.filter((t) => t.pfr_name && nameMatch(t.pfr_name, playerName));
      trades.sort((a, b) => b.season - a.season);
      trades = trades.slice(0, limit);

      const cols = ['season', 'trade_date', 'gave', 'received', 'pfr_name', 'pick_season', 'pick_round', 'pick_number', 'conditional'];
      const rows = trades.map((t) => pickColumns(t as unknown as Record<string, unknown>, cols));
      return `Trades (${trades.length} entries):\n\n${renderTable(input,rows, cols)}`;
    }

    case 'get_player_metrics': {
      const season = input.season as number;
      const playerName = input.player_name as string | undefined;
      const position = input.position as string | undefined;
      const team = input.team as string | undefined;
      const sortBy = (input.sort_by as string) || 'fantasy_points_ppr';
      const minGames = (input.min_games as number) || 4;
      const limit = clamp((input.limit as number) || 20, 1, 50);

      // Fetch all data sources in parallel
      const [raw, snaps, , pbpData] = await Promise.all([
        fetchPlayerStats(season),
        fetchSnapCounts(season),
        fetchGames(),
        fetchPlayByPlay(season),
      ]);

      const regWeekly = raw.filter((s) => s.season_type === 'REG');
      let totals = aggregateToSeasonTotals(regWeekly);
      if (position) totals = totals.filter((p) => p.position === position);
      if (team) totals = totals.filter((p) => p.recent_team === team.toUpperCase());
      if (playerName) totals = totals.filter((p) => nameMatch(p.player_display_name, playerName));
      totals = totals.filter((p) => p.games >= minGames);

      // Determine if we're computing QB or skill metrics
      const isQB = position === 'QB' || (!position && totals.every((p) => p.position === 'QB'));
      const isSkill = position === 'RB' || position === 'WR' || position === 'TE';

      // Index weekly stats by player
      const weeklyByPlayer = groupByPlayer(regWeekly);
      const snapsByPlayer = groupSnapsByPlayer(snaps);

      // Fetch position-specific data
      let ngsPassMap: Map<string, import('./types').NextGenStats> | undefined;
      let ngsRecMap: Map<string, import('./types').NextGenStats> | undefined;
      let ngsRushMap: Map<string, import('./types').NextGenStats> | undefined;
      let pfrPassByPlayer: Map<string, import('./types').AdvancedStats[]> | undefined;
      let pfrRecByPlayer: Map<string, import('./types').AdvancedStats[]> | undefined;
      let ftnData: import('./types').FTNCharting[] | undefined;
      let routeMap: Map<string, number> | undefined;

      // Fetch NGS/PFR/FTN based on position mix
      const fetches: Promise<void>[] = [];

      if (isQB || !isSkill) {
        fetches.push(
          fetchNextGenStats(season, 'passing').then((d) => { ngsPassMap = indexNGSByPlayer(d); }),
          fetchAdvancedStats(season, 'pass').then((d) => {
            pfrPassByPlayer = new Map<string, import('./types').AdvancedStats[]>();
            for (const row of d) {
              const id = row.pfr_player_id;
              if (!id) continue;
              const arr = pfrPassByPlayer.get(id);
              if (arr) arr.push(row); else pfrPassByPlayer.set(id, [row]);
            }
          }),
        );
        if (season >= 2022) {
          fetches.push(fetchFTNCharting(season).then((d) => { ftnData = d; }));
        }
      }

      if (isSkill || !isQB) {
        fetches.push(
          fetchNextGenStats(season, 'receiving').then((d) => { ngsRecMap = indexNGSByPlayer(d); }),
          fetchNextGenStats(season, 'rushing').then((d) => { ngsRushMap = indexNGSByPlayer(d); }),
          fetchAdvancedStats(season, 'rec').then((d) => {
            pfrRecByPlayer = new Map<string, import('./types').AdvancedStats[]>();
            for (const row of d) {
              const id = row.pfr_player_id;
              if (!id) continue;
              const arr = pfrRecByPlayer.get(id);
              if (arr) arr.push(row); else pfrRecByPlayer.set(id, [row]);
            }
          }),
        );
        // Estimate routes from participation
        fetches.push(
          fetchPbpParticipation(season).then((participation) => {
            routeMap = estimateRoutesRun(participation, pbpData);
          }).catch(() => { routeMap = undefined; }),
        );
      }

      await Promise.all(fetches);

      // Compute metrics per player
      const results: Array<QBMetrics | SkillMetrics> = [];

      for (const s of totals) {
        const weekly = weeklyByPlayer.get(s.player_id) || [];
        const playerSnaps = snapsByPlayer.get(s.player_id) || [];

        if (s.position === 'QB') {
          // Match FTN charting to this QB's plays via PBP
          const qbName = s.player_display_name ?? s.player_name;
          const qbPbp = pbpData.filter(
            (p) => p.passer_player_name === qbName || p.rusher_player_name === qbName
          );
          const qbGameIds = new Set(qbPbp.map((p) => p.game_id));
          const qbFtn = ftnData?.filter((f) => qbGameIds.has(f.nflverse_game_id));

          results.push(computeQBMetrics({
            seasonTotals: s,
            weeklyStats: weekly,
            pbp: pbpData,
            ngsPass: ngsPassMap?.get(s.player_id),
            pfrPass: pfrPassByPlayer?.get(s.player_id),
            ftn: qbFtn,
          }));
        } else {
          results.push(computeSkillMetrics({
            seasonTotals: s,
            weeklyStats: weekly,
            snaps: playerSnaps,
            ngsRec: ngsRecMap?.get(s.player_id),
            ngsRush: ngsRushMap?.get(s.player_id),
            pfrRec: pfrRecByPlayer?.get(s.player_id),
            routesRun: routeMap?.get(s.player_id),
          }));
        }
      }

      // Sort
      const sKey = sortBy as string;
      results.sort((a, b) => {
        const va = (a as unknown as Record<string, unknown>)[sKey];
        const vb = (b as unknown as Record<string, unknown>)[sKey];
        const na = typeof va === 'number' ? va : 0;
        const nb = typeof vb === 'number' ? vb : 0;
        return nb - na;
      });

      const sliced = results.slice(0, limit);

      // Pick columns based on position
      const qbCols = [
        'player_name', 'team', 'games',
        'completions', 'attempts', 'passing_yards', 'passing_tds', 'interceptions',
        'comp_pct', 'yards_per_attempt', 'adj_yards_per_attempt', 'td_pct', 'int_pct', 'passer_rating',
        'passing_epa', 'epa_per_dropback', 'cpoe',
        'sack_rate', 'pressure_rate', 'avg_time_to_throw', 'aggressiveness',
        'carries', 'rushing_yards', 'rushing_tds', 'scramble_rate', 'designed_rush_rate',
        'play_action_rate', 'screen_rate',
        'fantasy_points', 'fantasy_ppg',
      ];
      const skillCols = [
        'player_name', 'position', 'team', 'games', 'snap_pct',
        'carries', 'rushing_yards', 'rushing_tds', 'yards_per_carry', 'rushing_epa_per_att',
        'rush_yards_over_expected_per_att',
        'targets', 'receptions', 'receiving_yards', 'receiving_tds',
        'catch_rate', 'yards_per_reception', 'yards_per_target', 'receiving_epa_per_target',
        'target_share', 'air_yards_share', 'wopr', 'racr', 'yprr', 'routes_run',
        'avg_separation', 'avg_cushion', 'avg_yac', 'avg_yac_above_expected',
        'touches', 'opportunities_per_game', 'receiving_drop_rate',
        'fantasy_points_ppr', 'fantasy_ppg_ppr',
      ];

      // If mixed positions, use skill cols but check if any QBs
      const hasQBs = sliced.some((r) => 'passer_rating' in r);
      const hasSkill = sliced.some((r) => 'yprr' in r);
      let cols: string[];
      if (hasQBs && !hasSkill) cols = qbCols;
      else if (hasSkill && !hasQBs) cols = skillCols;
      else cols = ['player_name', 'position', 'team', 'games', 'fantasy_points_ppr', 'total_epa'];

      const rows = sliced.map((r) => pickColumns(r as unknown as Record<string, unknown>, cols));
      return `Player metrics for ${season} (${sliced.length} players, sorted by ${sortBy}):\n\n${renderTable(input,rows, cols)}`;
    }

    case 'get_qbr': {
      const season = input.season as number;
      const level = (input.level as string) || 'season';
      const playerName = input.player_name as string | undefined;
      const team = input.team as string | undefined;
      const week = input.week as number | undefined;
      const qualifiedOnly = input.qualified !== false;
      const sortBy = (input.sort_by as string) || 'qbr_total';
      const limit = clamp((input.limit as number) || 32, 1, 100);

      if (level === 'weekly') {
        let data = await fetchQBRWeek();
        data = data.filter((d) => d.season === season);
        if (playerName) data = data.filter((d) => nameMatch(d.name_display, playerName));
        if (team) data = data.filter((d) => d.team_abb === team.toUpperCase());
        if (week) data = data.filter((d) => d.week_num === week);
        // CSV parser coerces "TRUE" -> boolean true; compare tolerantly.
        if (qualifiedOnly) data = data.filter((d) => String(d.qualified).toUpperCase() === 'TRUE');

        const key = sortBy as keyof typeof data[0];
        data.sort((a, b) => {
          const va = typeof a[key] === 'number' ? (a[key] as number) : 0;
          const vb = typeof b[key] === 'number' ? (b[key] as number) : 0;
          return vb - va;
        });
        data = data.slice(0, limit);

        const cols = ['name_display', 'team_abb', 'week_num', 'opp_abb', 'qbr_total', 'pts_added',
          'qb_plays', 'epa_total', 'pass', 'run', 'sack', 'qbr_raw'];
        const rows = data.map((d) => pickColumns(d as unknown as Record<string, unknown>, cols));
        return `ESPN QBR weekly for ${season} (${data.length} entries):\n\n${renderTable(input,rows, cols)}`;
      } else {
        let data = await fetchQBRSeason();
        data = data.filter((d) => d.season === season && d.season_type === 'Regular');
        if (playerName) data = data.filter((d) => nameMatch(d.name_display, playerName));
        if (team) data = data.filter((d) => d.team_abb === team.toUpperCase());
        // CSV parser coerces "TRUE" -> boolean true; compare tolerantly.
        if (qualifiedOnly) data = data.filter((d) => String(d.qualified).toUpperCase() === 'TRUE');

        const key = sortBy as keyof typeof data[0];
        data.sort((a, b) => {
          const va = typeof a[key] === 'number' ? (a[key] as number) : 0;
          const vb = typeof b[key] === 'number' ? (b[key] as number) : 0;
          return vb - va;
        });
        data = data.slice(0, limit);

        const cols = ['name_display', 'team_abb', 'rank', 'qbr_total', 'pts_added',
          'qb_plays', 'epa_total', 'pass', 'run', 'sack', 'qbr_raw'];
        const rows = data.map((d) => pickColumns(d as unknown as Record<string, unknown>, cols));
        return `ESPN QBR season for ${season} (${data.length} QBs):\n\n${renderTable(input,rows, cols)}`;
      }
    }

    case 'get_draft_prospect_data': {
      const draftYear = input.draft_year as number | undefined;
      const position = input.position as string | undefined;
      const playerName = input.player_name as string | undefined;
      const school = input.school as string | undefined;
      const includeScouting = input.include_scouting as boolean || false;
      const sortBy = input.sort_by as string | undefined;
      const limit = clamp((input.limit as number) || 50, 1, 200);

      if (includeScouting) {
        // Use profiles dataset which includes scouting text
        let data = await fetchDraftProfiles();
        if (playerName) data = data.filter((d) => nameMatch(d.player_name, playerName));
        if (position) data = data.filter((d) => d.pos_abbr === position.toUpperCase());
        if (school) data = data.filter((d) => nameMatch(d.school, school));

        if (sortBy === 'grade') {
          data.sort((a, b) => (b.grade || 0) - (a.grade || 0));
        } else if (sortBy === 'ovr_rk') {
          data.sort((a, b) => (a.ovr_rk || 999) - (b.ovr_rk || 999));
        } else if (sortBy === 'pos_rk') {
          data.sort((a, b) => (a.pos_rk || 999) - (b.pos_rk || 999));
        }
        data = data.slice(0, limit);

        const cols = ['player_name', 'pos_abbr', 'school', 'height', 'weight',
          'ovr_rk', 'pos_rk', 'grade', 'text1', 'text2', 'text3', 'text4'];
        const rows = data.map((d) => pickColumns(d as unknown as Record<string, unknown>, cols));
        return `Draft profiles (${data.length} prospects):\n\n${renderTable(input,rows, cols)}`;
      } else {
        // Use prospects dataset (includes draft results)
        let data = await fetchDraftProspects();
        if (draftYear) data = data.filter((d) => d.draft_year === draftYear);
        if (position) data = data.filter((d) => d.pos_abbr === position.toUpperCase());
        if (playerName) data = data.filter((d) => nameMatch(d.player_name, playerName));
        if (school) data = data.filter((d) => nameMatch(d.school, school));

        if (sortBy === 'grade') {
          data.sort((a, b) => (b.grade || 0) - (a.grade || 0));
        } else if (sortBy === 'ovr_rk') {
          data.sort((a, b) => (a.ovr_rk || 999) - (b.ovr_rk || 999));
        } else if (sortBy === 'pos_rk') {
          data.sort((a, b) => (a.pos_rk || 999) - (b.pos_rk || 999));
        } else if (sortBy === 'overall') {
          data.sort((a, b) => (a.overall || 999) - (b.overall || 999));
        }
        data = data.slice(0, limit);

        const cols = ['draft_year', 'player_name', 'pos_abbr', 'school', 'round', 'overall',
          'team_abbr', 'height', 'weight', 'ovr_rk', 'pos_rk', 'grade'];
        const rows = data.map((d) => pickColumns(d as unknown as Record<string, unknown>, cols));
        return `Draft prospects (${data.length} players):\n\n${renderTable(input,rows, cols)}`;
      }
    }

    case 'get_college_stats': {
      const playerName = input.player_name as string | undefined;
      const season = input.season as number | undefined;
      const position = input.position as string | undefined;
      const school = input.school as string | undefined;
      const sortBy = input.sort_by as string | undefined;
      const limit = clamp((input.limit as number) || 100, 1, 500);

      // Require at least one bound so a cohort query can't dump the whole
      // 288k-row dataset. A class-level query (no player_name) needs a season
      // and/or school.
      if (!playerName && !season && !school) {
        return 'Provide player_name for one player, OR season (optionally with position/school) for a class/cohort query.';
      }

      // CFBD-backed college stats (2005–present). The legacy fetchCollegeStats
      // (JackLich10) is stale (ends 2020) and still used by the feature
      // pipeline, so only the tool switches to the current source.
      let data = await fetchCfbdCollegeStats();
      if (playerName) data = data.filter((d) => nameMatch(d.player_name, playerName));
      if (season) data = data.filter((d) => d.season === season);
      if (position) data = data.filter((d) => d.pos_abbr === position.toUpperCase());
      if (school) data = data.filter((d) => nameMatch(d.school_abbr || '', school) || nameMatch(d.school, school));

      if (data.length === 0) {
        return `No college stats found${playerName ? ` for "${playerName}"` : ''}.`;
      }

      // Pivot: one row per player+school+season, stats as columns.
      const pivoted = new Map<string, Record<string, unknown>>();
      for (const row of data) {
        // CFBD rows have no player_id; key on name+school+season.
        const key = `${row.player_name}-${row.school}-${row.season}`;
        if (!pivoted.has(key)) {
          pivoted.set(key, {
            player_name: row.player_name,
            pos_abbr: row.pos_abbr,
            school: row.school,
            season: row.season,
          });
        }
        pivoted.get(key)![row.statistic] = row.value;
      }

      let rows = Array.from(pivoted.values());
      // Rank a cohort by a stat column (e.g. "Rushing Yards"), else by season.
      if (sortBy) {
        rows.sort((a, b) => Number(b[sortBy] ?? 0) - Number(a[sortBy] ?? 0));
      } else {
        rows.sort((a, b) => (a.season as number) - (b.season as number));
      }
      rows = rows.slice(0, limit); // limit applies to player-seasons, not raw rows

      const scope = playerName
        ? `for "${playerName}"`
        : `cohort ${[season, position, school].filter(Boolean).join(' / ')}`;
      return `College stats ${scope} (${rows.length} player-seasons):\n\n${renderTable(input,rows)}`;
    }

    case 'get_college_qbr': {
      const season = input.season as number | undefined;
      const playerName = input.player_name as string | undefined;
      const sortBy = (input.sort_by as string) || 'total_qbr';
      const limit = clamp((input.limit as number) || 30, 1, 100);

      let data = await fetchCollegeQBR();
      if (season) data = data.filter((d) => d.season === season);
      if (playerName) data = data.filter((d) => nameMatch(d.player_name, playerName));

      const key = sortBy as keyof typeof data[0];
      data.sort((a, b) => {
        const va = typeof a[key] === 'number' ? (a[key] as number) : 0;
        const vb = typeof b[key] === 'number' ? (b[key] as number) : 0;
        return vb - va;
      });
      data = data.slice(0, limit);

      const cols = ['season', 'player_name', 'age', 'total_qbr', 'points_added',
        'qb_plays', 'total_epa', 'pass', 'run', 'sack', 'raw_qbr'];
      const rows = data.map((d) => pickColumns(d as unknown as Record<string, unknown>, cols));
      return `College QBR (${data.length} entries):\n\n${renderTable(input,rows, cols)}`;
    }

    case 'get_team_metrics': {
      const season = input.season as number;
      const team = input.team as string | undefined;
      const sortBy = (input.sort_by as string) || 'total_epa_per_play';

      const [games, pbpData] = await Promise.all([
        fetchGames(),
        fetchPlayByPlay(season),
      ]);

      let metrics = computeAllTeamMetrics(season, games, pbpData);

      if (team) {
        metrics = metrics.filter((m) => m.team === team.toUpperCase());
      }

      const sKey = sortBy as string;
      metrics.sort((a, b) => {
        const va = (a as unknown as Record<string, unknown>)[sKey];
        const vb = (b as unknown as Record<string, unknown>)[sKey];
        const na = typeof va === 'number' ? va : 0;
        const nb = typeof vb === 'number' ? vb : 0;
        return nb - na;
      });

      const cols = [
        'team', 'games', 'points_scored', 'points_allowed', 'point_diff', 'ppg',
        'total_plays', 'pass_rate', 'neutral_pass_rate',
        'yards_per_play', 'total_epa_per_play', 'pass_epa_per_play', 'rush_epa_per_play',
        'success_rate', 'plays_per_game',
        'turnovers', 'turnover_rate',
        'rz_attempts', 'rz_td_rate',
        'shotgun_rate', 'no_huddle_rate', 'deep_pass_rate', 'short_pass_rate',
        'def_epa_per_play', 'def_pass_epa_per_play', 'def_rush_epa_per_play', 'def_success_rate',
      ];
      const rows = metrics.map((m) => pickColumns(m as unknown as Record<string, unknown>, cols));
      return `Team metrics for ${season} (${metrics.length} teams, sorted by ${sortBy}):\n\n${renderTable(input,rows, cols)}`;
    }

    default:
      return `Unknown tool: ${name}`;
  }
}
