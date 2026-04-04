/**
 * Prior Stats feature group: prior-season passing, rushing, receiving stats + fantasy totals.
 */

import { registerGroup } from '../registry';
import type { FeatureGroup, PlayerKey } from '../types';

export const priorStatsGroup: FeatureGroup = {
  def: {
    id: 'priorStats',
    label: 'Prior Season Stats',
    featureKeys: [
      'priorPassYards', 'priorPassTDs', 'priorINTs', 'priorPassYPA', 'priorQBRating',
      'priorRushYards', 'priorRushTDs', 'priorYPC', 'priorCarries',
      'priorTargets', 'priorReceptions', 'priorRecYards', 'priorRecTDs', 'priorYPR',
      'priorPPR', 'priorPPG', 'priorGames', 'priorGamesMissed',
      'priorTotalTouches', 'priorSnapPct',
    ],
    dataDeps: ['priorStats', 'priorSnaps'],
    scope: 'seasonal',
  },
  compute: (ctx, _season) => {
    const results = new Map<PlayerKey, Record<string, number>>();
    for (const [pk, player] of ctx.players) {
      const prior = ctx.data.priorByName.get(player.normalName);
      const snapAcc = ctx.data.snapAccum.get(player.normalName);
      const snapPct = snapAcc && snapAcc.count > 0 ? snapAcc.total / snapAcc.count : 0;
      const priorGames = prior?.games || 0;
      const priorPPR = prior?.fantasy_points_ppr || 0;
      const priorAttempts = prior?.attempts || 0;
      const priorCarries = prior?.carries || 0;

      results.set(pk, {
        priorPassYards: prior?.passing_yards || 0,
        priorPassTDs: prior?.passing_tds || 0,
        priorINTs: prior?.interceptions || 0,
        priorPassYPA: priorAttempts > 0 ? Math.round((prior?.passing_yards || 0) / priorAttempts * 10) / 10 : 0,
        priorQBRating: 0,
        priorRushYards: prior?.rushing_yards || 0,
        priorRushTDs: prior?.rushing_tds || 0,
        priorYPC: priorCarries > 0 ? Math.round((prior?.rushing_yards || 0) / priorCarries * 10) / 10 : 0,
        priorCarries,
        priorTargets: prior?.targets || 0,
        priorReceptions: prior?.receptions || 0,
        priorRecYards: prior?.receiving_yards || 0,
        priorRecTDs: prior?.receiving_tds || 0,
        priorYPR: (prior?.receptions || 0) > 0
          ? Math.round((prior?.receiving_yards || 0) / (prior?.receptions || 1) * 10) / 10 : 0,
        priorPPR: Math.round(priorPPR * 10) / 10,
        priorPPG: priorGames > 0 ? Math.round(priorPPR / priorGames * 10) / 10 : 0,
        priorGames,
        priorGamesMissed: prior ? Math.max(0, 17 - priorGames) : 0,
        priorTotalTouches: priorCarries + (prior?.receptions || 0),
        priorSnapPct: Math.round(snapPct * 10) / 10,
      });
    }
    return results;
  },
};

registerGroup(priorStatsGroup);
