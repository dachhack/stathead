import type { SeasonTotals, Tab } from './types';

/**
 * Build a data context string to send to Claude based on the current tab and data.
 * We keep it concise to fit within token limits while giving Claude enough to be useful.
 */
export function buildDataContext(
  tab: Tab,
  season: number,
  seasonTotals: SeasonTotals[],
  extraData?: unknown[]
): string {
  const parts: string[] = [
    `The user is viewing the StatHead NFL Fantasy Workbench.`,
    `Current tab: ${tab}`,
    `Selected season: ${season}`,
  ];

  // Always include top fantasy players as core context
  if (seasonTotals.length > 0) {
    const topPlayers = [...seasonTotals]
      .sort((a, b) => b.fantasy_points_ppr - a.fantasy_points_ppr)
      .slice(0, 50);

    parts.push(
      `\nTop 50 players by PPR fantasy points (${season} season):`,
      formatPlayersTable(topPlayers)
    );
  }

  // Add tab-specific context
  switch (tab) {
    case 'stats':
    case 'compare':
    case 'scoring':
      // Player data already included above
      break;
    case 'games':
      if (extraData && extraData.length > 0) {
        parts.push(
          `\nGames data (${extraData.length} games loaded):`,
          formatAsTable(extraData.slice(0, 80), [
            'game_id', 'week', 'away_team', 'away_score', 'home_team',
            'home_score', 'result', 'total', 'spread_line', 'total_line',
            'surface', 'roof',
          ])
        );
      }
      break;
    case 'snaps':
      if (extraData && extraData.length > 0) {
        parts.push(
          `\nSnap count data (${extraData.length} entries, showing sample):`,
          formatAsTable(extraData.slice(0, 60), [
            'player', 'position', 'team', 'week', 'opponent',
            'offense_snaps', 'offense_pct', 'defense_snaps', 'defense_pct',
          ])
        );
      }
      break;
    case 'combine':
      if (extraData && extraData.length > 0) {
        parts.push(
          `\nCombine data (${extraData.length} entries, showing sample):`,
          formatAsTable(extraData.slice(0, 60), [
            'season', 'player_name', 'pos', 'school', 'ht', 'wt',
            'forty', 'bench', 'vertical', 'broad_jump', 'cone', 'shuttle',
            'draft_round', 'draft_ovr',
          ])
        );
      }
      break;
    case 'draft':
      if (extraData && extraData.length > 0) {
        parts.push(
          `\nDraft picks data (${extraData.length} entries, showing sample):`,
          formatAsTable(extraData.slice(0, 80), [
            'season', 'round', 'pick', 'team', 'pfr_player_name', 'position',
            'college', 'age', 'games', 'car_av', 'probowls', 'allpro', 'hof',
          ])
        );
      }
      break;
    case 'injuries':
      if (extraData && extraData.length > 0) {
        parts.push(
          `\nInjury report data (${extraData.length} entries, showing sample):`,
          formatAsTable(extraData.slice(0, 60), [
            'week', 'full_name', 'position', 'team',
            'report_primary_injury', 'report_status', 'practice_status',
          ])
        );
      }
      break;
    case 'advanced':
      if (extraData && extraData.length > 0) {
        parts.push(
          `\nAdvanced stats data (${extraData.length} entries, showing sample):`,
          formatAsTable(extraData.slice(0, 60), [
            'week', 'pfr_player_name', 'team', 'opponent',
            'passing_drops', 'passing_drop_pct', 'passing_bad_throws',
            'times_sacked', 'times_blitzed', 'times_hurried', 'times_pressured',
            'times_pressured_pct',
          ])
        );
      }
      break;
    case 'pbp':
      if (extraData && extraData.length > 0) {
        parts.push(
          `\nPlay-by-play data (${extraData.length} plays loaded, showing sample):`,
          formatAsTable(extraData.slice(0, 40), [
            'game_id', 'week', 'qtr', 'down', 'ydstogo', 'posteam', 'defteam',
            'play_type', 'yards_gained', 'epa', 'wpa', 'wp',
            'passer_player_name', 'rusher_player_name', 'receiver_player_name',
          ])
        );
      }
      break;
  }

  parts.push(
    `\nYou have access to the full nflverse dataset including play-by-play (1999+), ` +
    `snap counts (2012+), combine, draft picks (1980+), injuries (2009+), ` +
    `advanced stats (2018+), and game schedules. Answer questions about NFL stats, ` +
    `fantasy football, and provide analysis based on the data shown above. ` +
    `If the user asks about data not shown, let them know which tab to navigate to. ` +
    `Be specific with numbers and cite the data. Format responses in markdown.`
  );

  return parts.join('\n');
}

function formatPlayersTable(players: SeasonTotals[]): string {
  const header = 'Name|Pos|Team|G|PassYd|PassTD|INT|RushYd|RushTD|Rec|RecYd|RecTD|FPts|PPR';
  const rows = players.map(
    (p) =>
      `${p.player_display_name}|${p.position}|${p.recent_team}|${p.games}|` +
      `${r(p.passing_yards)}|${p.passing_tds}|${p.interceptions}|` +
      `${r(p.rushing_yards)}|${p.rushing_tds}|${p.receptions}|` +
      `${r(p.receiving_yards)}|${p.receiving_tds}|` +
      `${p.fantasy_points.toFixed(1)}|${p.fantasy_points_ppr.toFixed(1)}`
  );
  return [header, ...rows].join('\n');
}

function formatAsTable(data: unknown[], columns: string[]): string {
  const header = columns.join('|');
  const rows = (data as Record<string, unknown>[]).map((row) =>
    columns.map((col) => {
      const val = row[col];
      if (val == null) return '';
      if (typeof val === 'number') return Number.isInteger(val) ? String(val) : val.toFixed(2);
      return String(val);
    }).join('|')
  );
  return [header, ...rows].join('\n');
}

function r(n: number): string {
  return Math.round(n).toString();
}
