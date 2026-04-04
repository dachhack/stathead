/**
 * Competition feature group: roster competition, depth chart, teammate quality.
 */

import { registerGroup } from '../registry';
import type { FeatureGroup, PlayerKey } from '../types';

export const competitionGroup: FeatureGroup = {
  def: {
    id: 'competition',
    label: 'Roster Competition',
    featureKeys: [
      'teamSamePosCount', 'depthChartRank', 'priorTeamTouchShare',
      'priorTeamTargetShare', 'newSamePosAdded', 'teamDraftedSamePos',
      'draftCapitalSamePos', 'teammatePriorPPR',
      'teamWRElitePPR', 'teamWRTop12', 'teamWRTotalPPR',
      'teamTEElitePPR', 'teamRBElitePPR', 'teamRBTop12',
      'teamPassCatcherPPR', 'teamElitePassCatchers', 'teamTargetHHI',
      'newArrivalBestPPR', 'newArrivalBestADP', 'teamRosterTurnover',
    ],
    dataDeps: ['rosters', 'depthCharts', 'priorStats', 'draft'],
    scope: 'seasonal',
  },
  compute: (ctx, _season) => {
    // Competition features require complex roster analysis.
    // Populated via legacy bridge or full extraction.
    const results = new Map<PlayerKey, Record<string, number>>();
    for (const [pk] of ctx.players) {
      results.set(pk, {
        teamSamePosCount: 0, depthChartRank: 99,
        priorTeamTouchShare: 0, priorTeamTargetShare: 0,
        newSamePosAdded: 0, teamDraftedSamePos: 0,
        draftCapitalSamePos: 0, teammatePriorPPR: 0,
        teamWRElitePPR: 0, teamWRTop12: 0, teamWRTotalPPR: 0,
        teamTEElitePPR: 0, teamRBElitePPR: 0, teamRBTop12: 0,
        teamPassCatcherPPR: 0, teamElitePassCatchers: 0, teamTargetHHI: 0,
        newArrivalBestPPR: 0, newArrivalBestADP: 0, teamRosterTurnover: 0,
      });
    }
    return results;
  },
};

registerGroup(competitionGroup);
