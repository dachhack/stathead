/**
 * Environment feature group: dome games, bye week, O-line quality.
 * Derived from game schedules and PBP data.
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

    // Read pre-built environment maps from context
    const envMaps = (ctx.data as any).environmentMaps as {
      teamDomeGames: Map<string, number>;
      teamByeWeek: Map<string, number>;
      teamSackRate: Map<string, number>;
      teamRushYPC: Map<string, number>;
    } | undefined;

    for (const [pk, player] of ctx.players) {
      const team = player.team;
      results.set(pk, {
        teamDomeGames: envMaps?.teamDomeGames.get(team) || 0,
        byeWeek: envMaps?.teamByeWeek.get(team) || 0,
        teamSackRate: envMaps?.teamSackRate.get(team) || 0,
        teamRushYPC: envMaps?.teamRushYPC.get(team) || 0,
      });
    }
    return results;
  },
};

registerGroup(environmentGroup);
