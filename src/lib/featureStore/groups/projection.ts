/**
 * Projection feature group: ML volume projections, team projections, share predictions.
 */

import { registerGroup } from '../registry';
import type { FeatureGroup, PlayerKey } from '../types';

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
    for (const [pk] of ctx.players) {
      results.set(pk, {
        projTeamPassAtt: 0, projTeamPassVolChg: 0, projPlayerPPR: 0,
        projPlayerVsExpected: 0, projTargetShare: 0,
        mlProjTeamPassAtt: 0, mlProjTeamRushAtt: 0, mlProjTeamTargets: 0,
        mlProjPlayerPPG: 0,
        actualTargetShare: 0, actualRushShare: 0, actualReceptionShare: 0,
        actualRecYdsShare: 0, actualRushYdsShare: 0, actualPassTDShare: 0,
        actualRushTDShare: 0,
        predTargetShare: 0, predRushShare: 0, predReceptionShare: 0,
        predRecYdsShare: 0, predRushYdsShare: 0, predPassTDShare: 0,
        predRushTDShare: 0,
      });
    }
    return results;
  },
};

registerGroup(projectionGroup);
