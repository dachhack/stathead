/**
 * Environment feature group: dome games, bye week, O-line, weather.
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
  compute: (ctx, _season) => {
    const results = new Map<PlayerKey, Record<string, number>>();
    for (const [pk] of ctx.players) {
      results.set(pk, {
        teamDomeGames: 0, byeWeek: 0, teamSackRate: 0, teamRushYPC: 0,
      });
    }
    return results;
  },
};

registerGroup(environmentGroup);
