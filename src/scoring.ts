import type { ScoringFormat, ScoringSettings, SeasonTotals } from './types';

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

  return (
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
    player.special_teams_tds * settings.special_teams_td
  );
}
