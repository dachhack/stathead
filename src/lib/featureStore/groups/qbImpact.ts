/**
 * QB Impact feature group: QB rushing tendencies, team QB stats, passer rating.
 * Identifies the starting QB per team and computes their impact on skill positions.
 */

import { registerGroup } from '../registry';
import type { FeatureGroup, PlayerKey } from '../types';
import { POSITIONS } from '../../featureTypes';

export const qbImpactGroup: FeatureGroup = {
  def: {
    id: 'qbImpact',
    label: 'QB Impact',
    featureKeys: [
      'qbOwnRushAtt', 'qbOwnRushYds', 'qbOwnRushTDs',
      'qbOwnRushShare', 'qbOwnScrambleRate', 'qbOwnPPG',
      'teamPriorQBRushAtt', 'teamPriorQBRushShare', 'teamPriorQBScrambleRate',
      'teamQBPassRating',
    ],
    dataDeps: ['priorStats', 'currentStats', 'rosters', 'depthCharts'],
    scope: 'seasonal',
  },
  compute: (ctx, _season) => {
    const results = new Map<PlayerKey, Record<string, number>>();
    const d = ctx.data;

    // Find starting QB per team from prior season (highest PPR QB)
    const teamQBStats = new Map<string, {
      rushAtt: number; rushYds: number; rushTDs: number;
      rushShare: number; scrambleRate: number; ppg: number;
      passRating: number;
    }>();

    // Aggregate QB stats from prior season by team
    for (const [name, prior] of d.priorByName) {
      if (prior.position !== 'QB') continue;
      const team = prior.recent_team || '';
      if (!team) continue;

      const existing = teamQBStats.get(team);
      const ppg = prior.games > 0 ? (prior.fantasy_points_ppr || 0) / prior.games : 0;

      // Keep the QB with highest PPG for each team
      if (!existing || ppg > existing.ppg) {
        const carries = prior.carries || 0;
        const attempts = prior.attempts || 0;
        const games = prior.games || 1;

        // NFL passer rating approximation
        const compPct = attempts > 0 ? (prior.completions || 0) / attempts : 0;
        const ypa = attempts > 0 ? (prior.passing_yards || 0) / attempts : 0;
        const tdPct = attempts > 0 ? (prior.passing_tds || 0) / attempts : 0;
        const intPct = attempts > 0 ? (prior.interceptions || 0) / attempts : 0;
        const a = Math.min(2.375, Math.max(0, (compPct - 0.3) * 5));
        const b = Math.min(2.375, Math.max(0, (ypa - 3) * 0.25));
        const c = Math.min(2.375, Math.max(0, tdPct * 20));
        const dd = Math.min(2.375, Math.max(0, 2.375 - intPct * 25));
        const passRating = Math.round(((a + b + c + dd) / 6) * 100 * 10) / 10;

        teamQBStats.set(team, {
          rushAtt: carries,
          rushYds: prior.rushing_yards || 0,
          rushTDs: prior.rushing_tds || 0,
          rushShare: carries > 0 ? Math.round(carries / Math.max(1, carries + attempts) * 1000) / 1000 : 0,
          scrambleRate: attempts > 0 ? Math.round(carries / (attempts + carries) * 1000) / 1000 : 0,
          ppg: Math.round(ppg * 10) / 10,
          passRating,
        });
      }
    }

    for (const [pk, player] of ctx.players) {
      const team = player.team;
      const qb = teamQBStats.get(team);

      results.set(pk, {
        qbOwnRushAtt: qb?.rushAtt || 0,
        qbOwnRushYds: qb?.rushYds || 0,
        qbOwnRushTDs: qb?.rushTDs || 0,
        qbOwnRushShare: qb?.rushShare || 0,
        qbOwnScrambleRate: qb?.scrambleRate || 0,
        qbOwnPPG: qb?.ppg || 0,
        teamPriorQBRushAtt: qb?.rushAtt || 0,
        teamPriorQBRushShare: qb?.rushShare || 0,
        teamPriorQBScrambleRate: qb?.scrambleRate || 0,
        teamQBPassRating: qb?.passRating || 0,
      });
    }
    return results;
  },
};

registerGroup(qbImpactGroup);
