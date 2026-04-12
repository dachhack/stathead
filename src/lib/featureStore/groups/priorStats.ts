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

      // NFL passer rating from prior-season stats (same formula as qbImpact.ts).
      // Previously hardcoded to 0 — actual stats were always available right here.
      const priorCompletions = prior?.completions || 0;
      const priorPassTDs = prior?.passing_tds || 0;
      const priorInts = prior?.interceptions || 0;
      const priorPassYards = prior?.passing_yards || 0;
      let priorQBRating = 0;
      if (priorAttempts > 0) {
        const compPct = priorCompletions / priorAttempts;
        const ypa = priorPassYards / priorAttempts;
        const tdPct = priorPassTDs / priorAttempts;
        const intPct = priorInts / priorAttempts;
        const aComp = Math.min(2.375, Math.max(0, (compPct - 0.3) * 5));
        const bYpa = Math.min(2.375, Math.max(0, (ypa - 3) * 0.25));
        const cTd = Math.min(2.375, Math.max(0, tdPct * 20));
        const dInt = Math.min(2.375, Math.max(0, 2.375 - intPct * 25));
        priorQBRating = Math.round(((aComp + bYpa + cTd + dInt) / 6) * 100 * 10) / 10;
      }

      results.set(pk, {
        priorPassYards,
        priorPassTDs,
        priorINTs: priorInts,
        priorPassYPA: priorAttempts > 0 ? Math.round(priorPassYards / priorAttempts * 10) / 10 : 0,
        priorQBRating,
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
