/**
 * Projection & share feature group.
 * - ML volume projections (populated during prediction, 0 for training)
 * - Actual share targets (from current season outcomes — training data)
 * - Predicted shares (from share models — prediction data)
 */

import { registerGroup } from '../registry';
import type { FeatureGroup, PlayerKey } from '../types';
import { POSITIONS } from '../../featureTypes';

export const projectionGroup: FeatureGroup = {
  def: {
    id: 'projection',
    label: 'Projections & Shares',
    featureKeys: [
      'projTeamPassAtt', 'projTeamPassVolChg', 'projPlayerPPR',
      'projPlayerVsExpected', 'projTargetShare',
      'mlProjTeamPassAtt', 'mlProjTeamRushAtt', 'mlProjTeamTargets',
      'mlProjPlayerPPG',
      'actualTargetShare', 'actualRushShare', 'actualReceptionShare',
      'actualRecYdsShare', 'actualRushYdsShare', 'actualPassTDShare',
      'actualRushTDShare',
      'predTargetShare', 'predRushShare', 'predReceptionShare',
      'predRecYdsShare', 'predRushYdsShare', 'predPassTDShare',
      'predRushTDShare',
    ],
    dataDeps: ['priorStats', 'currentStats'],
    scope: 'seasonal',
  },
  compute: (ctx, _season) => {
    const results = new Map<PlayerKey, Record<string, number>>();
    const d = ctx.data;

    // Compute current-season team totals for share calculations
    const teamTotals = new Map<string, {
      targets: number; carries: number; receptions: number;
      recYds: number; rushYds: number; passTDs: number; rushTDs: number;
    }>();

    for (const [_name, current] of d.currentByName) {
      if (!POSITIONS.includes(current.position)) continue;
      const team = current.recent_team || '';
      if (!team) continue;
      if (!teamTotals.has(team)) {
        teamTotals.set(team, {
          targets: 0, carries: 0, receptions: 0,
          recYds: 0, rushYds: 0, passTDs: 0, rushTDs: 0,
        });
      }
      const t = teamTotals.get(team)!;
      t.targets += current.targets || 0;
      t.carries += current.carries || 0;
      t.receptions += current.receptions || 0;
      t.recYds += current.receiving_yards || 0;
      t.rushYds += current.rushing_yards || 0;
      t.passTDs += current.receiving_tds || 0;
      t.rushTDs += current.rushing_tds || 0;
    }

    for (const [pk, player] of ctx.players) {
      const current = d.currentByName.get(player.normalName);
      const curTeam = current?.recent_team || player.team || '';
      const tt = teamTotals.get(curTeam);

      // Actual shares (training data — computed from current season outcomes)
      const actTargetShare = tt && tt.targets > 0
        ? Math.round((current?.targets || 0) / tt.targets * 1000) / 1000 : 0;
      const actRushShare = tt && tt.carries > 0
        ? Math.round((current?.carries || 0) / tt.carries * 1000) / 1000 : 0;
      const actRecShare = tt && tt.receptions > 0
        ? Math.round((current?.receptions || 0) / tt.receptions * 1000) / 1000 : 0;
      const actRecYdsShare = tt && tt.recYds > 0
        ? Math.round((current?.receiving_yards || 0) / tt.recYds * 1000) / 1000 : 0;
      const actRushYdsShare = tt && tt.rushYds > 0
        ? Math.round((current?.rushing_yards || 0) / tt.rushYds * 1000) / 1000 : 0;
      const actPassTDShare = tt && tt.passTDs > 0
        ? Math.round((current?.receiving_tds || 0) / tt.passTDs * 1000) / 1000 : 0;
      const actRushTDShare = tt && tt.rushTDs > 0
        ? Math.round((current?.rushing_tds || 0) / tt.rushTDs * 1000) / 1000 : 0;

      results.set(pk, {
        // Projection features (populated for 2026 predictions, 0 for training)
        projTeamPassAtt: 0,
        projTeamPassVolChg: 0,
        projPlayerPPR: 0,
        projPlayerVsExpected: 0,
        projTargetShare: 0,
        mlProjTeamPassAtt: 0,
        mlProjTeamRushAtt: 0,
        mlProjTeamTargets: 0,
        mlProjPlayerPPG: 0,
        // Actual shares
        actualTargetShare: actTargetShare,
        actualRushShare: actRushShare,
        actualReceptionShare: actRecShare,
        actualRecYdsShare: actRecYdsShare,
        actualRushYdsShare: actRushYdsShare,
        actualPassTDShare: actPassTDShare,
        actualRushTDShare: actRushTDShare,
        // Predicted shares (populated by share models)
        predTargetShare: 0,
        predRushShare: 0,
        predReceptionShare: 0,
        predRecYdsShare: 0,
        predRushYdsShare: 0,
        predPassTDShare: 0,
        predRushTDShare: 0,
      });
    }
    return results;
  },
};

registerGroup(projectionGroup);
