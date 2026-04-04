/**
 * Environment feature group: dome games, bye week, O-line quality, QB passer rating.
 */

import { registerGroup } from '../registry';
import type { FeatureGroup, PlayerKey } from '../types';

export const environmentGroup: FeatureGroup = {
  def: {
    id: 'environment',
    label: 'Team Environment',
    featureKeys: ['teamDomeGames', 'byeWeek', 'teamSackRate', 'teamRushYPC'],
    dataDeps: ['games', 'pbp'],
    scope: 'seasonal',
  },
  compute: (ctx, season) => {
    const results = new Map<PlayerKey, Record<string, number>>();

    // Dome games and bye week from games data
    // Sack rate and rush YPC from PBP data
    // These require game-level and PBP processing done in contextBuilder
    for (const [pk, player] of ctx.players) {
      results.set(pk, {
        teamDomeGames: 0,
        byeWeek: 0,
        teamSackRate: 0,
        teamRushYPC: 0,
      });
    }
    return results;
  },
};

registerGroup(environmentGroup);
