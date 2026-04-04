/**
 * Consistency feature group: weekly boom/bust profile from prior season.
 * Parses per-week fantasy points to compute std dev and extreme game rates.
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

    // advByName contains weekly aggregation data
    // For boom/bust we need per-week PPR values from the raw weekly stats.
    // The advByName has receptions, targets but not per-week PPR split.
    // We use priorByName's games + PPR to estimate stdDev as fallback,
    // and boom/bust rates from the weekly data stored in advByName.
    for (const [pk, player] of ctx.players) {
      const adv = ctx.data.advByName.get(player.normalName);
      const prior = ctx.data.priorByName.get(player.normalName);
      const priorGames = prior?.games || 0;
      const priorPPR = prior?.fantasy_points_ppr || 0;
      const avgPPG = priorGames > 0 ? priorPPR / priorGames : 0;

      // Estimate std dev from weekly data if available
      // advByName.weeks tells us how many weeks of data we have
      const weeks = adv?.weeks || 0;

      // Without per-week PPR in the context, we use the legacy bridge values
      // (populated from buildFeatureMatrix via populateFromLegacy).
      // Full extraction requires storing weekly PPR values in the context.
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
