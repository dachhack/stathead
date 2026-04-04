/**
 * Momentum feature group: 2-year trends in PPG, targets, touches, ADP, snap%.
 */

import { registerGroup } from '../registry';
import type { FeatureGroup, PlayerKey } from '../types';

export const momentumGroup: FeatureGroup = {
  def: {
    id: 'momentum',
    label: 'Momentum Trends',
    featureKeys: [
      'ppgTrend', 'targetTrend', 'touchTrend',
      'adpTrend', 'snapPctTrend', 'targetShareTrend',
    ],
    dataDeps: ['priorStats', 'adp', 'priorSnaps'],
    scope: 'seasonal',
  },
  compute: (ctx, season) => {
    const results = new Map<PlayerKey, Record<string, number>>();
    for (const [pk, player] of ctx.players) {
      const hist = ctx.data.playerHistoryMap?.get(player.normalName) || [];
      const sorted = [...hist].sort((a: any, b: any) => b.season - a.season);
      const curr = sorted.find((h: any) => h.season === season - 1);
      const prev = sorted.find((h: any) => h.season === season - 2);

      if (!curr || !prev) {
        results.set(pk, {
          ppgTrend: 0, targetTrend: 0, touchTrend: 0,
          adpTrend: 0, snapPctTrend: 0, targetShareTrend: 0,
        });
        continue;
      }

      results.set(pk, {
        ppgTrend: Math.round((curr.ppg - prev.ppg) * 10) / 10,
        targetTrend: curr.targets - prev.targets,
        touchTrend: curr.touches - prev.touches,
        adpTrend: prev.adp > 0 && curr.adp > 0 ? Math.round((prev.adp - curr.adp) * 10) / 10 : 0,
        snapPctTrend: Math.round((curr.snapPct - prev.snapPct) * 10) / 10,
        targetShareTrend: Math.round((curr.targetShare - prev.targetShare) * 1000) / 1000,
      });
    }
    return results;
  },
};

registerGroup(momentumGroup);
