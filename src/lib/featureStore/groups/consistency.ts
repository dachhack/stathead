/**
 * Consistency feature group: weekly boom/bust profile from prior season.
 */

import { registerGroup } from '../registry';
import type { FeatureGroup, PlayerKey } from '../types';
import { normalizeName } from '../../featureTypes';

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

    // Build weekly consistency from prior season weekly stats
    // This data comes through advByName's weekly aggregation in the context
    // For full implementation, we'd parse individual week PPR values
    for (const [pk] of ctx.players) {
      results.set(pk, {
        priorPPGStdDev: 0,
        priorBoomRate: 0,
        priorBustGameRate: 0,
      });
    }
    return results;
  },
};

registerGroup(consistencyGroup);
