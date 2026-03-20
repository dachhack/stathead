/**
 * Tool definitions for Claude's tool-use API.
 * Each tool maps to a data-fetching function + optional client-side processing.
 */

import type { Tool, ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages';
import {
  fetchPlayerStats, aggregateToSeasonTotals, fetchGames,
  fetchSnapCounts, fetchCombine, fetchDraftPicks, fetchInjuries,
  fetchAdvancedStats, fetchPlayByPlay, fetchFantasyRankings,
  fetchSleeperTrending, fetchSleeperProjections,
  fetchKTCRankings, fetchFfcADP, fetchEspnADP,
} from './data';
import type { SeasonTotals } from './types';

// ── Tool Definitions ──

export const NFL_TOOLS: Tool[] = [
  {
    name: 'get_player_season_stats',
    description:
      'Get aggregated season totals for NFL players. Returns rushing, passing, receiving, and fantasy stats. ' +
      'Supports filtering by position (QB, RB, WR, TE) and sorting by any stat column. ' +
      'Use this for questions about player performance, fantasy points, rankings, comparisons.',
    input_schema: {
      type: 'object' as const,
      properties: {
        season: { type: 'number', description: 'NFL season year (2015-2025)' },
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
      'career approximate value, Pro Bowls, All-Pro selections, Hall of Fame status. ' +
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
        season: { type: 'number', description: 'NFL season year (2018+)' },
        stat_type: {
          type: 'string',
          description: 'Type of advanced stats',
          enum: ['pass', 'rush', 'rec', 'def'],
        },
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
      'Get FantasyPros ECR (Expert Consensus Rankings) and ADP data. ' +
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
      'Get Average Draft Position from Fantasy Football Calculator or ESPN. ' +
      'Use for draft value analysis, comparing ADP across platforms.',
    input_schema: {
      type: 'object' as const,
      properties: {
        source: { type: 'string', description: 'Data source', enum: ['ffc', 'espn'] },
        season: { type: 'number', description: 'Season year' },
        scoring: { type: 'string', description: 'Scoring format (FFC only)', enum: ['standard', 'ppr', 'half-ppr'] },
        teams: { type: 'number', description: 'League size (FFC only)', enum: [8, 10, 12, 14] },
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
      'Get KeepTradeCut dynasty player values and rankings. ' +
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
];

// ── Tool Execution ──

type ToolInput = Record<string, unknown>;

function nameMatch(fullName: string, query: string): boolean {
  return fullName.toLowerCase().includes(query.toLowerCase());
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
      return `${season} season stats (${totals.length} players, sorted by ${sortBy}):\n\n${toMarkdownTable(rows, cols)}`;
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
      return `Weekly stats for "${playerName}" in ${season} (weeks ${weekStart}-${weekEnd}):\n\n${toMarkdownTable(rows, cols)}`;
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
      return `Games (${games.length} results):\n\n${toMarkdownTable(rows, cols)}`;
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
      return `Snap counts for ${season} (${snaps.length} entries):\n\n${toMarkdownTable(rows, cols)}`;
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
      return `Combine results (${combine.length} players):\n\n${toMarkdownTable(rows, cols)}`;
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
      return `Draft picks (${picks.length} entries):\n\n${toMarkdownTable(rows, cols)}`;
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
      return `Injury reports for ${season} (${injuries.length} entries):\n\n${toMarkdownTable(rows, cols)}`;
    }

    case 'get_advanced_stats': {
      const season = input.season as number;
      const statType = input.stat_type as 'pass' | 'rush' | 'rec' | 'def';
      const playerName = input.player_name as string | undefined;
      const limit = clamp((input.limit as number) || 40, 1, 100);

      let stats = await fetchAdvancedStats(season, statType);
      if (playerName) {
        stats = stats.filter((s) => nameMatch(
          (s as unknown as Record<string, unknown>).pfr_player_name as string || '', playerName
        ));
      }
      stats = stats.slice(0, limit);

      // Return all columns
      const rows = stats as unknown as Record<string, unknown>[];
      return `Advanced ${statType} stats for ${season} (${stats.length} entries):\n\n${toMarkdownTable(rows)}`;
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
      return `Play-by-play for ${season} (${plays.length} plays):\n\n${toMarkdownTable(rows, cols)}`;
    }

    case 'get_fantasy_rankings': {
      const position = input.position as string | undefined;
      const limit = clamp((input.limit as number) || 50, 1, 200);

      let rankings = await fetchFantasyRankings();
      if (position) rankings = rankings.filter((r) => r.pos === position.toUpperCase());
      rankings = rankings.slice(0, limit);

      const cols = ['player', 'pos', 'team', 'ecr', 'sd', 'best', 'worst', 'player_owned_avg', 'page_type'];
      const rows = rankings.map((r) => pickColumns(r as unknown as Record<string, unknown>, cols));
      return `Fantasy rankings (${rankings.length} players):\n\n${toMarkdownTable(rows, cols)}`;
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
        return `FFC ADP for ${season} (${scoring}, ${teams}-team, ${data.length} players):\n\n${toMarkdownTable(rows)}`;
      } else {
        let data = await fetchEspnADP(season);
        data = data.slice(0, limit);
        const rows = data as unknown as Record<string, unknown>[];
        return `ESPN ADP for ${season} (${data.length} players):\n\n${toMarkdownTable(rows)}`;
      }
    }

    case 'get_sleeper_trending': {
      const type = (input.type as 'add' | 'drop') || 'add';
      const hours = (input.hours as number) || 24;
      const limit = clamp((input.limit as number) || 25, 1, 50);

      const data = await fetchSleeperTrending(type, hours, limit);
      const cols = ['full_name', 'position', 'team', 'age', 'count'];
      const rows = data.map((d) => pickColumns(d as unknown as Record<string, unknown>, cols));
      return `Sleeper trending ${type}s (last ${hours}h, ${data.length} players):\n\n${toMarkdownTable(rows, cols)}`;
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
      return `Sleeper projections for ${season}${week ? ` week ${week}` : ''} (${data.length} players):\n\n${toMarkdownTable(rows, cols)}`;
    }

    case 'get_dynasty_values': {
      const format = (input.format as '1qb' | 'superflex') || '1qb';
      const position = input.position as string | undefined;
      const playerName = input.player_name as string | undefined;
      const limit = clamp((input.limit as number) || 50, 1, 200);

      let data = await fetchKTCRankings(format);
      if (position) data = data.filter((d) => d.position === position.toUpperCase());
      if (playerName) data = data.filter((d) => nameMatch(d.playerName, playerName));
      data = data.slice(0, limit);

      const cols = ['playerName', 'position', 'positionRank', 'team', 'age', 'value', 'superflexValue', 'isRookie'];
      const rows = data.map((d) => pickColumns(d as unknown as Record<string, unknown>, cols));
      return `KTC dynasty values (${format}, ${data.length} players):\n\n${toMarkdownTable(rows, cols)}`;
    }

    default:
      return `Unknown tool: ${name}`;
  }
}
