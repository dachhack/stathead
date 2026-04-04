/**
 * Coaching & scheme feature group: pass rate, pace, personnel rates, scheme flags.
 */

import { registerGroup } from '../registry';
import type { FeatureGroup, PlayerKey } from '../types';

export const coachingGroup: FeatureGroup = {
  def: {
    id: 'coaching',
    label: 'Coaching & Scheme',
    featureKeys: [
      'newHeadCoach', 'coachPriorTeamPPR',
      'teamPassRate', 'teamNeutralPassRate', 'teamPace',
      'teamFirstDownRunRate', 'teamShotgunRate', 'teamNoHuddleRate',
      'teamRBTargetRate',
      // Personnel
      'team11Rate', 'team12Rate', 'team13Rate', 'team21Rate',
      'team22Rate', 'team10Rate', 'teamTETargetRate', 'teamWRTargetRate',
      'teamTETargetsPerGame', 'teamRBTargetsPerGame',
      'teamWR3PlusOnField', 'team2PlusTEOnField',
      // Scheme cluster flags
      'schemePassHeavy', 'schemeRunHeavy', 'schemeUptempo',
      'schemeShotgunHeavy', 'schemeRBReceiving', 'schemeTEHeavy',
    ],
    dataDeps: ['pbp', 'games', 'participation'],
    scope: 'seasonal',
  },
  compute: (ctx, _season) => {
    // Coaching features require complex PBP analysis.
    // Populated via legacy bridge or full extraction.
    const results = new Map<PlayerKey, Record<string, number>>();
    for (const [pk] of ctx.players) {
      results.set(pk, {
        newHeadCoach: 0, coachPriorTeamPPR: 0,
        teamPassRate: 0, teamNeutralPassRate: 0, teamPace: 0,
        teamFirstDownRunRate: 0, teamShotgunRate: 0, teamNoHuddleRate: 0,
        teamRBTargetRate: 0,
        team11Rate: 0, team12Rate: 0, team13Rate: 0, team21Rate: 0,
        team22Rate: 0, team10Rate: 0, teamTETargetRate: 0, teamWRTargetRate: 0,
        teamTETargetsPerGame: 0, teamRBTargetsPerGame: 0,
        teamWR3PlusOnField: 0, team2PlusTEOnField: 0,
        schemePassHeavy: 0, schemeRunHeavy: 0, schemeUptempo: 0,
        schemeShotgunHeavy: 0, schemeRBReceiving: 0, schemeTEHeavy: 0,
      });
    }
    return results;
  },
};

registerGroup(coachingGroup);
