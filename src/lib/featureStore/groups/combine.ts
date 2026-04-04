/**
 * Combine feature group: physical measurables from NFL Combine.
 * Static per player — doesn't change across seasons.
 */

import { registerGroup } from '../registry';
import type { FeatureGroup, PlayerKey } from '../types';
import { parseHeight } from '../../featureTypes';

export const combineGroup: FeatureGroup = {
  def: {
    id: 'combine',
    label: 'Combine Measurables',
    featureKeys: [
      'weight', 'forty', 'bench', 'vertical', 'broadJump',
      'cone', 'shuttle', 'bmi', 'hasCombineData',
    ],
    dataDeps: ['combine'],
    scope: 'static',
    positions: ['RB', 'WR', 'TE'],
  },
  compute: (ctx, _season) => {
    const results = new Map<PlayerKey, Record<string, number>>();
    for (const [pk, player] of ctx.players) {
      const combine = ctx.data.combineByName.get(player.normalName);
      const avg = ctx.data.combineAvg.get(player.position);
      const heightIn = combine?.ht ? parseHeight(combine.ht) : 0;
      const wt = combine?.wt || 0;
      const bmi = heightIn > 0 && wt > 0 ? Math.round((703 * wt) / (heightIn * heightIn) * 10) / 10 : 0;

      results.set(pk, {
        weight: wt || avg?.weight || 0,
        forty: combine?.forty || avg?.forty || 0,
        bench: combine?.bench || avg?.bench || 0,
        vertical: combine?.vertical || avg?.vertical || 0,
        broadJump: combine?.broad_jump || avg?.broadJump || 0,
        cone: combine?.cone || avg?.cone || 0,
        shuttle: combine?.shuttle || avg?.shuttle || 0,
        bmi,
        hasCombineData: combine ? 1 : 0,
      });
    }
    return results;
  },
};

registerGroup(combineGroup);
