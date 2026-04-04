/**
 * QB Impact feature group: QB rushing tendencies, team QB stats.
 */

import { registerGroup } from '../registry';
import type { FeatureGroup, PlayerKey } from '../types';

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
    dataDeps: ['priorStats', 'currentStats'],
    scope: 'seasonal',
  },
  compute: (ctx, _season) => {
    const results = new Map<PlayerKey, Record<string, number>>();
    for (const [pk] of ctx.players) {
      results.set(pk, {
        qbOwnRushAtt: 0, qbOwnRushYds: 0, qbOwnRushTDs: 0,
        qbOwnRushShare: 0, qbOwnScrambleRate: 0, qbOwnPPG: 0,
        teamPriorQBRushAtt: 0, teamPriorQBRushShare: 0, teamPriorQBScrambleRate: 0,
        teamQBPassRating: 0,
      });
    }
    return results;
  },
};

registerGroup(qbImpactGroup);
