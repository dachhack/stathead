/**
 * Advanced stats feature group: target share, air yards, WOPR, RACR, EPA, PBP-derived.
 */

import { registerGroup } from '../registry';
import type { FeatureGroup, PlayerKey } from '../types';

export const advancedGroup: FeatureGroup = {
  def: {
    id: 'advanced',
    label: 'Advanced Stats',
    featureKeys: [
      'priorTargetShare', 'priorAirYardsShare', 'priorWOPR', 'priorRACR',
      'priorYACperRec', 'priorAirYardsPerTarget', 'priorRecEPA', 'priorRushEPA',
      'priorADOT', 'priorDeepTargetPct', 'priorRZTargetShare',
    ],
    dataDeps: ['priorStats', 'pbp'],
    scope: 'seasonal',
  },
  compute: (ctx, _season) => {
    const results = new Map<PlayerKey, Record<string, number>>();
    for (const [pk, player] of ctx.players) {
      const adv = ctx.data.advByName.get(player.normalName);
      const advWeeks = adv?.weeks || 1;
      const avgTargetShare = adv ? adv.targetShare / advWeeks : 0;
      const avgAirYardsShare = adv ? adv.airYardsShare / advWeeks : 0;
      const avgWOPR = adv ? adv.wopr / advWeeks : 0;
      const avgRACR = adv ? adv.racr / advWeeks : 0;
      const yacPerRec = adv && adv.receptions > 0 ? adv.yac / adv.receptions : 0;
      const airYardsPerTarget = adv && adv.targets > 0 ? adv.airYards / adv.targets : 0;

      // PBP derived (aDOT, deep %, RZ target share)
      const pbpRec = (ctx.data as any).pbpByReceiver?.get(player.normalName);
      const adot = pbpRec && pbpRec.targets > 0 ? pbpRec.airYards / pbpRec.targets : (adv && adv.targets > 0 ? adv.airYards / adv.targets : 0);
      const deepPct = pbpRec && pbpRec.targets > 0 ? pbpRec.deepTargets / pbpRec.targets : 0;
      const teamRZ = (ctx.data as any).teamRZTargets?.get(player.team) || 1;
      const rzTargetShare = pbpRec ? pbpRec.rzTargets / teamRZ : 0;

      results.set(pk, {
        priorTargetShare: Math.round(avgTargetShare * 1000) / 1000,
        priorAirYardsShare: Math.round(avgAirYardsShare * 1000) / 1000,
        priorWOPR: Math.round(avgWOPR * 1000) / 1000,
        priorRACR: Math.round(avgRACR * 100) / 100,
        priorYACperRec: Math.round(yacPerRec * 10) / 10,
        priorAirYardsPerTarget: Math.round(airYardsPerTarget * 10) / 10,
        priorRecEPA: Math.round((adv?.recEPA || 0) * 10) / 10,
        priorRushEPA: Math.round((adv?.rushEPA || 0) * 10) / 10,
        priorADOT: Math.round(adot * 10) / 10,
        priorDeepTargetPct: Math.round(deepPct * 1000) / 1000,
        priorRZTargetShare: Math.round(rzTargetShare * 1000) / 1000,
      });
    }
    return results;
  },
};

registerGroup(advancedGroup);
