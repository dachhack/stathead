/**
 * Injury feature group: prior injury history (all from season S-1, no leakage).
 *
 * Note: preseasonInjured / preseasonInjWeeks were previously in this group
 * but the nflverse injuries CSV has no actual preseason data — only
 * game_type=REG rows starting at week=1. The feature names were aspirational.
 * A week-1-2-of-current-season proxy was tried in #120 but that's outcome
 * leakage (we're predicting that season's PPG). Removed and replaced with
 * priorLateSeasonInjured / priorLateSeasonInjWeeks derived from weeks 15-18
 * of season S-1 — captures "ended last year hurt" without any lookahead.
 */

import { registerGroup } from '../registry';
import type { FeatureGroup, PlayerKey } from '../types';

export const injuriesGroup: FeatureGroup = {
  def: {
    id: 'injuries',
    label: 'Injury History',
    featureKeys: [
      'priorInjuryWeeks', 'priorGamesOut',
      'priorLateSeasonInjured', 'priorLateSeasonInjWeeks',
      'priorSoftTissue', 'priorKneeInjury',
      'injuryRecurrence',
    ],
    dataDeps: ['injuries'],
    scope: 'seasonal',
  },
  compute: (ctx, _season) => {
    const results = new Map<PlayerKey, Record<string, number>>();
    for (const [pk, player] of ctx.players) {
      const inj = ctx.data.injuryByName?.get(player.normalName);

      results.set(pk, {
        priorInjuryWeeks: inj?.weeks || 0,
        priorGamesOut: inj?.gamesOut || 0,
        priorLateSeasonInjured: inj?.lateSeasonInjured ? 1 : 0,
        priorLateSeasonInjWeeks: inj?.lateSeasonInjWeeks || 0,
        priorSoftTissue: inj?.softTissue ? 1 : 0,
        priorKneeInjury: inj?.knee ? 1 : 0,
        injuryRecurrence: (ctx.data as any).injuryRecurrence?.get(player.normalName) || 0,
      });
    }
    return results;
  },
};

registerGroup(injuriesGroup);
