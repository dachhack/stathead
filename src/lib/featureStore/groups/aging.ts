/**
 * Aging feature group: age curve delta, peak/decline indicators.
 */

import { registerGroup } from '../registry';
import type { FeatureGroup, PlayerKey } from '../types';

const AGING_CURVES: Record<string, { peakStart: number; peakEnd: number; declineStart: number }> = {
  QB: { peakStart: 27, peakEnd: 32, declineStart: 35 },
  RB: { peakStart: 23, peakEnd: 26, declineStart: 28 },
  WR: { peakStart: 25, peakEnd: 29, declineStart: 31 },
  TE: { peakStart: 25, peakEnd: 29, declineStart: 31 },
};

export const agingGroup: FeatureGroup = {
  def: {
    id: 'aging',
    label: 'Aging Curves',
    featureKeys: ['ageCurveDelta', 'isPeakAge', 'isDeclineAge'],
    dataDeps: ['draft'],
    scope: 'seasonal',
  },
  compute: (ctx, season) => {
    const results = new Map<PlayerKey, Record<string, number>>();
    for (const [pk, player] of ctx.players) {
      const draft = ctx.data.draftByName.get(player.normalName);
      const draftAge = draft?.age || 0;
      const draftYear = draft?.season || 0;
      const playerAge = draftAge > 0 && draftYear > 0 ? draftAge + (season - draftYear) : 0;
      const curve = AGING_CURVES[player.position];

      if (!curve || playerAge === 0) {
        results.set(pk, { ageCurveDelta: 0, isPeakAge: 0, isDeclineAge: 0 });
        continue;
      }

      const isPeak = playerAge >= curve.peakStart && playerAge <= curve.peakEnd ? 1 : 0;
      const isDecline = playerAge >= curve.declineStart ? 1 : 0;
      const delta = isPeak ? 0.5 : isDecline ? -0.3 * (playerAge - curve.declineStart + 1) : 0;

      results.set(pk, {
        ageCurveDelta: Math.round(delta * 100) / 100,
        isPeakAge: isPeak,
        isDeclineAge: isDecline,
      });
    }
    return results;
  },
};

registerGroup(agingGroup);
