/**
 * Vegas feature group: implied totals, spreads, win %, season props, SOS.
 */

import { registerGroup } from '../registry';
import type { FeatureGroup, PlayerKey } from '../types';

export const vegasGroup: FeatureGroup = {
  def: {
    id: 'vegas',
    label: 'Vegas & SOS',
    featureKeys: [
      'vegasImpliedTotal', 'vegasImpliedSpread', 'vegasGameTotal',
      'vegasWinPct', 'vegasActualPtsPerGame',
      'vegasSeasonWinTotal', 'vegasSeasonOverUnder',
      'sosDefPassYdg', 'sosDefRushYdg', 'sosDefPPG', 'sosAvgSpread',
    ],
    dataDeps: ['games'],
    scope: 'seasonal',
  },
  compute: (ctx, season) => {
    const results = new Map<PlayerKey, Record<string, number>>();
    for (const [pk, player] of ctx.players) {
      const vKey = `${season - 1}:${player.team}`;
      const v = ctx.data.vegasBySeasonTeam.get(vKey);
      const vGames = v?.games || 1;
      const vp = ctx.data.vegasSeasonProps?.get(player.team);

      results.set(pk, {
        vegasImpliedTotal: v ? Math.round((v.impliedTotal / vGames) * 10) / 10 : 0,
        vegasImpliedSpread: v ? Math.round((v.spread / vGames) * 10) / 10 : 0,
        vegasGameTotal: v ? Math.round((v.gameTotal / vGames) * 10) / 10 : 0,
        vegasWinPct: v ? Math.round((v.wins / vGames) * 1000) / 1000 : 0,
        vegasActualPtsPerGame: v ? Math.round((v.actualPts / vGames) * 10) / 10 : 0,
        vegasSeasonWinTotal: vp?.winTotal || 0,
        vegasSeasonOverUnder: vp?.avgOU || 0,
        sosDefPassYdg: 0,
        sosDefRushYdg: 0,
        sosDefPPG: 0,
        sosAvgSpread: 0,
      });
    }
    return results;
  },
};

registerGroup(vegasGroup);
