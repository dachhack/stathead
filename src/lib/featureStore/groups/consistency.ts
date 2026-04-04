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

    // Build per-player weekly PPR values from advByName's weekly data
    // The context builder stores weekly PPR in a special weeklyPPR map
    const weeklyPPR = (ctx.data as any).weeklyPPRByName as Map<string, number[]> | undefined;

    // Build consistency metrics
    const consistency = new Map<string, { stdDev: number; boomRate: number; bustGameRate: number }>();
    if (weeklyPPR) {
      for (const [name, pts] of weeklyPPR) {
        if (pts.length < 3) continue;
        const mean = pts.reduce((a, b) => a + b, 0) / pts.length;
        const variance = pts.reduce((s, v) => s + (v - mean) ** 2, 0) / pts.length;
        const stdDev = Math.sqrt(variance);
        consistency.set(name, {
          stdDev: Math.round(stdDev * 10) / 10,
          boomRate: Math.round(pts.filter(p => p >= 20).length / pts.length * 1000) / 1000,
          bustGameRate: Math.round(pts.filter(p => p < 5).length / pts.length * 1000) / 1000,
        });
      }
    }

    for (const [pk, player] of ctx.players) {
      const wc = consistency.get(player.normalName);
      results.set(pk, {
        priorPPGStdDev: wc?.stdDev || 0,
        priorBoomRate: wc?.boomRate || 0,
        priorBustGameRate: wc?.bustGameRate || 0,
      });
    }
    return results;
  },
};

registerGroup(consistencyGroup);
