/**
 * Next Gen Stats feature group: separation, cushion, CPOE, RYOE, etc.
 */

import { registerGroup } from '../registry';
import type { FeatureGroup, PlayerKey } from '../types';

export const ngsGroup: FeatureGroup = {
  def: {
    id: 'ngs',
    label: 'Next Gen Stats',
    featureKeys: [
      'priorSeparation', 'priorCushion', 'priorYACAboveExp',
      'priorCatchPct', 'priorIntendedAirYardShare',
      'priorRYOEperAtt', 'priorRushEfficiency', 'priorPctVs8Defenders',
      'priorCPOE', 'priorTimeToThrow', 'priorAggressiveness',
    ],
    dataDeps: ['ngs'],
    scope: 'seasonal',
  },
  compute: (ctx, _season) => {
    const results = new Map<PlayerKey, Record<string, number>>();
    for (const [pk, player] of ctx.players) {
      const ngsRec = ctx.data.ngsRecByName.get(player.normalName);
      const ngsRush = ctx.data.ngsRushByName.get(player.normalName);
      const ngsPass = ctx.data.ngsPassByName.get(player.normalName);

      results.set(pk, {
        priorSeparation: ngsRec?.avg_separation || 0,
        priorCushion: ngsRec?.avg_cushion || 0,
        priorYACAboveExp: ngsRec?.avg_yac_above_expectation || 0,
        priorCatchPct: ngsRec?.catch_percentage || 0,
        priorIntendedAirYardShare: ngsRec?.percent_share_of_intended_air_yards || 0,
        priorRYOEperAtt: ngsRush?.rush_yards_over_expected_per_att || 0,
        priorRushEfficiency: ngsRush?.efficiency || 0,
        priorPctVs8Defenders: ngsRush?.percent_attempts_gte_eight_defenders || 0,
        priorCPOE: ngsPass?.completion_percentage_above_expectation || 0,
        priorTimeToThrow: ngsPass?.avg_time_to_throw || 0,
        priorAggressiveness: ngsPass?.aggressiveness || 0,
      });
    }
    return results;
  },
};

registerGroup(ngsGroup);
