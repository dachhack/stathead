/**
 * Routes feature group: YPRR, routes run, personnel splits from participation data.
 */

import { registerGroup } from '../registry';
import type { FeatureGroup, PlayerKey } from '../types';

export const routesGroup: FeatureGroup = {
  def: {
    id: 'routes',
    label: 'Route & Personnel',
    featureKeys: [
      'priorYPRR', 'priorRoutesRun', 'priorTargetsPerRoute',
      'priorPct11Personnel', 'priorPct12Personnel',
      'priorPassLocationLeft', 'priorPassLocationMiddle',
    ],
    dataDeps: ['participation', 'priorStats', 'pbp'],
    scope: 'seasonal',
  },
  compute: (ctx, _season) => {
    const results = new Map<PlayerKey, Record<string, number>>();
    for (const [pk, player] of ctx.players) {
      const rt = ctx.data.routesByName?.get(player.normalName);
      const prior = ctx.data.priorByName.get(player.normalName);

      results.set(pk, {
        priorYPRR: rt && rt.routesRun > 0
          ? Math.round(((prior?.receiving_yards || 0) / rt.routesRun) * 100) / 100 : 0,
        priorRoutesRun: rt?.routesRun || 0,
        priorTargetsPerRoute: rt && rt.routesRun > 0
          ? Math.round(((prior?.targets || 0) / rt.routesRun) * 1000) / 1000 : 0,
        priorPct11Personnel: rt && rt.totalSnaps > 0
          ? Math.round((rt.snaps11 / rt.totalSnaps) * 1000) / 1000 : 0,
        priorPct12Personnel: rt && rt.totalSnaps > 0
          ? Math.round((rt.snaps12 / rt.totalSnaps) * 1000) / 1000 : 0,
        priorPassLocationLeft: 0, // filled from PBP pass location data
        priorPassLocationMiddle: 0,
      });
    }
    return results;
  },
};

registerGroup(routesGroup);
