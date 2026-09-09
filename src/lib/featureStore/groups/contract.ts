/**
 * Contract feature group: APY, guaranteed money, cap percentage.
 * Uses the deal in force for the season being computed (newest signing on
 * or before it), never a later extension — see src/lib/contracts.ts.
 */

import { registerGroup } from '../registry';
import type { FeatureGroup, PlayerKey } from '../types';
import { contractForSeason, contractFeatures } from '../../contracts';

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
      const c = contractForSeason(ctx.data.contractsByName, player.normalName, season);
      results.set(pk, contractFeatures(c, season));
    }
    return results;
  },
};

registerGroup(contractGroup);
