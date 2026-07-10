import type { ScoringFormat, ScoringSettings, SeasonTotals } from './types';
import {
  estimateBigPlays,
  estimateMilestoneGames,
  estimateRecFirstDowns,
  estimateRushFirstDowns,
} from './lib/sfbScoring';

export const SCORING_PRESETS: Record<ScoringFormat, ScoringSettings> = {
  standard: {
    passing_yard: 0.04,
    passing_td: 4,
    interception: -2,
    rushing_yard: 0.1,
    rushing_td: 6,
    receiving_yard: 0.1,
    receiving_td: 6,
    reception: 0,
    fumble_lost: -2,
    two_pt_conversion: 2,
    special_teams_td: 6,
    first_down: 0,
    te_reception_bonus: 0,
    te_first_down_bonus: 0,
    big_play_bonus: 0,
  },
  half_ppr: {
    passing_yard: 0.04,
    passing_td: 4,
    interception: -2,
    rushing_yard: 0.1,
    rushing_td: 6,
    receiving_yard: 0.1,
    receiving_td: 6,
    reception: 0.5,
    fumble_lost: -2,
    two_pt_conversion: 2,
    special_teams_td: 6,
    first_down: 0,
    te_reception_bonus: 0,
    te_first_down_bonus: 0,
    big_play_bonus: 0,
  },
  ppr: {
    passing_yard: 0.04,
    passing_td: 4,
    interception: -2,
    rushing_yard: 0.1,
    rushing_td: 6,
    receiving_yard: 0.1,
    receiving_td: 6,
    reception: 1,
    fumble_lost: -2,
    two_pt_conversion: 2,
    special_teams_td: 6,
    first_down: 0,
    te_reception_bonus: 0,
    te_first_down_bonus: 0,
    big_play_bonus: 0,
  },
  // Scott Fish Bowl 16 (2026): 6-pt passing TDs, half-point receptions and
  // first downs, TE premium on both, no turnover penalties, and +10
  // "video game" bonuses for big plays and milestone games (see
  // lib/sfbScoring.ts for what's exact vs estimated).
  sfb: {
    passing_yard: 0.04,
    passing_td: 6,
    interception: 0,
    rushing_yard: 0.1,
    rushing_td: 6,
    receiving_yard: 0.1,
    receiving_td: 6,
    reception: 0.5,
    fumble_lost: 0,
    two_pt_conversion: 2,
    special_teams_td: 6,
    first_down: 0.5,
    te_reception_bonus: 1,
    te_first_down_bonus: 1,
    big_play_bonus: 10,
  },
  custom: {
    passing_yard: 0.04,
    passing_td: 4,
    interception: -2,
    rushing_yard: 0.1,
    rushing_td: 6,
    receiving_yard: 0.1,
    receiving_td: 6,
    reception: 1,
    fumble_lost: -2,
    two_pt_conversion: 2,
    special_teams_td: 6,
    first_down: 0,
    te_reception_bonus: 0,
    te_first_down_bonus: 0,
    big_play_bonus: 0,
  },
};

export function calculateFantasyPoints(
  player: SeasonTotals,
  settings: ScoringSettings
): number {
  const totalFumblesLost =
    player.rushing_fumbles_lost +
    player.receiving_fumbles_lost +
    player.sack_fumbles_lost;
  const total2pt =
    player.passing_2pt_conversions +
    player.rushing_2pt_conversions +
    player.receiving_2pt_conversions;

  let pts =
    player.passing_yards * settings.passing_yard +
    player.passing_tds * settings.passing_td +
    player.interceptions * settings.interception +
    player.rushing_yards * settings.rushing_yard +
    player.rushing_tds * settings.rushing_td +
    player.receiving_yards * settings.receiving_yard +
    player.receiving_tds * settings.receiving_td +
    player.receptions * settings.reception +
    totalFumblesLost * settings.fumble_lost +
    total2pt * settings.two_pt_conversion +
    player.special_teams_tds * settings.special_teams_td;

  if (settings.te_reception_bonus && player.position === 'TE') {
    pts += player.receptions * settings.te_reception_bonus;
  }

  if (settings.first_down || settings.te_first_down_bonus) {
    // Exact nflverse first-down totals when aggregated; estimated from
    // volume/efficiency for producers that don't carry them.
    const rushFD =
      player.rushing_first_downs ??
      estimateRushFirstDowns(player.position, player.carries, player.rushing_yards);
    const recFD =
      player.receiving_first_downs ??
      estimateRecFirstDowns(player.position, player.receptions);
    pts += (rushFD + recFD) * settings.first_down;
    if (player.position === 'TE') {
      pts += recFD * settings.te_first_down_bonus;
    }
  }

  if (settings.big_play_bonus) {
    const line = {
      position: player.position,
      games: player.games,
      passAtt: player.attempts,
      passYds: player.passing_yards,
      rushAtt: player.carries,
      rushYds: player.rushing_yards,
      rec: player.receptions,
      recYds: player.receiving_yards,
      games300Pass: player.games_300_pass,
      games400Pass: player.games_400_pass,
      games100Scrim: player.games_100_scrim,
      games200Scrim: player.games_200_scrim,
    };
    pts += (estimateBigPlays(line) + estimateMilestoneGames(line)) * settings.big_play_bonus;
  }

  return pts;
}
