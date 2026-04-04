/**
 * Injury feature group: prior injury history, preseason status, recurrence risk.
 */

import { registerGroup } from '../registry';
import type { FeatureGroup, PlayerKey } from '../types';

export const injuriesGroup: FeatureGroup = {
  def: {
    id: 'injuries',
    label: 'Injury History',
    featureKeys: [
      'priorInjuryWeeks', 'priorGamesOut', 'preseasonInjured',
      'preseasonInjWeeks', 'priorSoftTissue', 'priorKneeInjury',
      'injuryRecurrence',
    ],
    dataDeps: ['injuries'],
    scope: 'seasonal',
  },
  compute: (ctx, _season) => {
    const results = new Map<PlayerKey, Record<string, number>>();
    for (const [pk, player] of ctx.players) {
      const inj = ctx.data.injuryByName?.get(player.normalName);
      const preInj = ctx.data.preseasonInjuryByName?.get(player.normalName);

      results.set(pk, {
        priorInjuryWeeks: inj?.weeks || 0,
        priorGamesOut: inj?.gamesOut || 0,
        preseasonInjured: preInj?.injured ? 1 : 0,
        preseasonInjWeeks: preInj?.weeks || 0,
        priorSoftTissue: inj?.softTissue ? 1 : 0,
        priorKneeInjury: inj?.knee ? 1 : 0,
        injuryRecurrence: 0, // filled from cross-season injury tracking
      });
    }
    return results;
  },
};

registerGroup(injuriesGroup);
