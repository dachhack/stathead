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
  compute: (ctx, season) => {
    const results = new Map<PlayerKey, Record<string, number>>();
    const d = ctx.data;

    // Coach change detection
    const coachChangeTeams = new Set<string>();
    for (const [key, coach] of d.coachBySeasonTeam) {
      const [szn, team] = key.split(':');
      if (Number(szn) === season) {
        const priorCoach = d.coachBySeasonTeam.get(`${season - 1}:${team}`);
        if (priorCoach && priorCoach !== coach) coachChangeTeams.add(team);
      }
    }

    for (const [pk, player] of ctx.players) {
      const team = player.team;
      const scheme = d.schemeByTeam.get(team) as any;
      const totalPlays = scheme?.plays || 1;
      const totalGames = scheme?.games || 1;
      const pers = d.personnelByTeam.get(team) as any;
      const persTotal = pers?.total || 1;
      const schTotalTgts = scheme?.totalTargets || 1;

      // Scheme-derived rates
      const passRate = scheme ? scheme.passes / totalPlays : 0;
      const shotgunRate = scheme ? scheme.shotgunPlays / totalPlays : 0;
      const pace = scheme ? totalPlays / totalGames : 0;
      const rbTgtRate = scheme ? scheme.rbTargets / schTotalTgts : 0;
      const teTgtRate = scheme ? scheme.teTargets / schTotalTgts : 0;

      results.set(pk, {
        newHeadCoach: coachChangeTeams.has(team) ? 1 : 0,
        coachPriorTeamPPR: (() => {
          let totalPPR = 0;
          for (const [, prior] of d.priorByName) {
            if (prior.recent_team === team && ['QB', 'RB', 'WR', 'TE'].includes(prior.position)) {
              totalPPR += prior.fantasy_points_ppr || 0;
            }
          }
          return Math.round(totalPPR * 10) / 10;
        })(),
        teamPassRate: scheme ? Math.round(passRate * 1000) / 1000 : 0,
        teamNeutralPassRate: scheme && scheme.neutralPlays > 0
          ? Math.round((scheme.neutralPasses / scheme.neutralPlays) * 1000) / 1000 : 0,
        teamPace: scheme ? Math.round(pace * 10) / 10 : 0,
        teamFirstDownRunRate: scheme && scheme.firstDownPlays > 0
          ? Math.round((scheme.firstDownRuns / scheme.firstDownPlays) * 1000) / 1000 : 0,
        teamShotgunRate: scheme ? Math.round(shotgunRate * 1000) / 1000 : 0,
        teamNoHuddleRate: scheme ? Math.round((scheme.noHuddlePlays / totalPlays) * 1000) / 1000 : 0,
        teamRBTargetRate: scheme ? Math.round(rbTgtRate * 1000) / 1000 : 0,

        // Personnel rates
        team11Rate: pers ? Math.round((pers.p11 / persTotal) * 1000) / 1000 : 0,
        team12Rate: pers ? Math.round((pers.p12 / persTotal) * 1000) / 1000 : 0,
        team13Rate: pers ? Math.round((pers.p13 / persTotal) * 1000) / 1000 : 0,
        team21Rate: pers ? Math.round((pers.p21 / persTotal) * 1000) / 1000 : 0,
        team22Rate: pers ? Math.round((pers.p22 / persTotal) * 1000) / 1000 : 0,
        team10Rate: pers ? Math.round((pers.p10 / persTotal) * 1000) / 1000 : 0,
        teamTETargetRate: scheme ? Math.round(teTgtRate * 1000) / 1000 : 0,
        teamWRTargetRate: scheme ? Math.round((scheme.wrTargets / schTotalTgts) * 1000) / 1000 : 0,
        teamTETargetsPerGame: scheme ? Math.round((scheme.teTargets / totalGames) * 10) / 10 : 0,
        teamRBTargetsPerGame: scheme ? Math.round((scheme.rbTargets / totalGames) * 10) / 10 : 0,
        teamWR3PlusOnField: pers ? Math.round((pers.wr3plus / persTotal) * 1000) / 1000 : 0,
        team2PlusTEOnField: pers ? Math.round((pers.te2plus / persTotal) * 1000) / 1000 : 0,

        // Scheme flags
        schemePassHeavy: passRate > 0.58 ? 1 : 0,
        schemeRunHeavy: passRate < 0.48 ? 1 : 0,
        schemeUptempo: pace > 67 ? 1 : 0,
        schemeShotgunHeavy: shotgunRate > 0.70 ? 1 : 0,
        schemeRBReceiving: rbTgtRate > 0.18 ? 1 : 0,
        schemeTEHeavy: teTgtRate > 0.22 ? 1 : 0,
      });
    }
    return results;
  },
};

registerGroup(coachingGroup);
