/**
 * Contract feature group: APY, guaranteed money, cap percentage.
 */

import { registerGroup } from '../registry';
import type { FeatureGroup, PlayerKey } from '../types';

export const contractGroup: FeatureGroup = {
  def: {
    id: 'contract',
    label: 'Contract Data',
    featureKeys: [
      'contractAPY', 'contractGuaranteed', 'contractAPYCapPct',
      'contractYearsRemaining',
    ],
    dataDeps: ['contracts'],
    scope: 'seasonal', // years remaining changes per season
  },
  compute: (ctx, season) => {
    const results = new Map<PlayerKey, Record<string, number>>();
    for (const [pk, player] of ctx.players) {
      const c = ctx.data.contractByName.get(player.normalName);
      const yearsRem = c ? Math.max(0, c.years - (season - c.year_signed)) : 0;

      results.set(pk, {
        contractAPY: c ? Math.round(c.apy / 1_000_000 * 10) / 10 : 0,
        contractGuaranteed: c ? Math.round(c.guaranteed / 1_000_000 * 10) / 10 : 0,
        contractAPYCapPct: c ? Math.round(c.apy_cap_pct * 100) / 100 : 0,
        contractYearsRemaining: yearsRem,
      });
    }
    return results;
  },
};

registerGroup(contractGroup);
