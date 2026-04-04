/**
 * Consistency feature group: weekly boom/bust profile.
 */

import { registerGroup } from '../registry';
import type { FeatureGroup, PlayerKey } from '../types';

export const consistencyGroup: FeatureGroup = {
  def: {
    id: 'consistency',
    label: 'Weekly Consistency',
    featureKeys: ['priorPPGStdDev', 'priorBoomRate', 'priorBustGameRate'],
    dataDeps: ['priorStats'],
    scope: 'seasonal',
  },
  compute: (ctx, _season) => {
    const results = new Map<PlayerKey, Record<string, number>>();
    for (const [pk] of ctx.players) {
      results.set(pk, {
        priorPPGStdDev: 0, priorBoomRate: 0, priorBustGameRate: 0,
      });
    }
    return results;
  },
};

registerGroup(consistencyGroup);
