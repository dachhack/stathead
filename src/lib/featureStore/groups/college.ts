/**
 * College feature group: college stats, ZAP-inspired metrics, prospect grades.
 * Static per player — doesn't change across seasons.
 */

import { registerGroup } from '../registry';
import type { FeatureGroup, PlayerKey } from '../types';
import { parseHeight } from '../../featureTypes';

export const collegeGroup: FeatureGroup = {
  def: {
    id: 'college',
    label: 'College Production',
    featureKeys: [
      'collegePassYds', 'collegePassTDs', 'collegeRushYds', 'collegeRecYds',
      'collegeRecTDs', 'collegeTotalTDs', 'collegeQBR',
      'collegeGames', 'collegeRecPerGame', 'collegeYdsPerGame',
      'collegeTDsPerGame', 'collegeRushYPC', 'collegeYdsPerRec',
      'collegeBestRecYds', 'collegeBestRecTDs', 'collegeBestReceptions',
      'collegeBestRushYds', 'collegeSeasons',
      'prospectGrade', 'prospectPosRank', 'prospectOvlRank',
      'collegeDominatorRating', 'collegeBreakoutAge', 'collegeBreakoutAgeDelta',
      'collegeMarketShare', 'speedScore',
      'collegeRecYdsPerTeamPassAtt', 'collegeReceptionShare',
      'collegeYdsPerTeamPlay', 'collegeBreakoutScore',
      'collegeBestRecYdsPerTPA', 'collegeRushProductionWR',
      'collegeEarlyDeclare', 'collegeTeammateScore',
      'heightAdjSpeedScore', 'draftCapXSpeed',
      'hasCollegeStats', 'hasProspectGrade',
    ],
    dataDeps: ['college', 'combine', 'draft', 'prospects'],
    scope: 'static',
  },
  compute: (ctx, _season) => {
    const results = new Map<PlayerKey, Record<string, number>>();
    for (const [pk, player] of ctx.players) {
      const cs = ctx.data.collegeByName.get(player.normalName);
      const pg = ctx.data.collegePerGameByName.get(player.normalName);
      const adv = ctx.data.collegeAdvancedByName.get(player.normalName);
      const best = ctx.data.collegeBestSeasonByName.get(player.normalName);
      const prospect = ctx.data.prospectByName.get(player.normalName);
      const posAvg = ctx.data.collegeAvgByPos.get(player.position) || {};
      const draft = ctx.data.draftByName.get(player.normalName);
      const draftAge = draft?.age || 0;

      const _hasCollege = cs ? 1 : 0;
      const _hasProspect = prospect?.grade ? 1 : 0;
      const imp = (raw: number | undefined, field: string) => raw || posAvg[field] || 0;

      // ZAP features
      const zap = ctx.data.collegeZapByName.get(player.normalName);
      const ts = ctx.data.teammateScoreByName.get(player.normalName) || 0;
      const combine = ctx.data.combineByName.get(player.normalName);
      const ht = parseHeight(combine?.ht || '') || 0;
      const ss = ctx.data.speedScoreByName.get(player.normalName) || 0;
      const htAdjSpeedScore = (ht > 0 && ss > 0) ? Math.round(ss * (ht / 76) * 10) / 10 : ss;
      const draftPick = draft?.pick || 0;
      const draftCapXSpeed = (draftPick > 0 && ss > 0) ? Math.round((1 / draftPick) * ss * 1000) / 1000 : 0;

      results.set(pk, {
        collegePassYds: imp(cs?.get('Passing Yards'), 'collegePassYds'),
        collegePassTDs: imp(cs?.get('Passing Touchdowns'), 'collegePassTDs'),
        collegeRushYds: imp(cs?.get('Rushing Yards'), 'collegeRushYds'),
        collegeRecYds: imp(cs?.get('Receiving Yards'), 'collegeRecYds'),
        collegeRecTDs: imp(cs?.get('Receiving Touchdowns'), 'collegeRecTDs'),
        collegeTotalTDs: cs
          ? (cs.get('Passing Touchdowns') || 0) + (cs.get('Rushing Touchdowns') || 0) + (cs.get('Receiving Touchdowns') || 0)
          : posAvg['collegeTotalTDs'] || 0,
        collegeQBR: 0, // filled from QBR data when available
        collegeGames: pg?.games || 0,
        collegeRecPerGame: imp(pg?.recPerGame, 'collegeRecPerGame'),
        collegeYdsPerGame: imp(pg?.ydsPerGame, 'collegeYdsPerGame'),
        collegeTDsPerGame: imp(pg?.tdsPerGame, 'collegeTDsPerGame'),
        collegeRushYPC: imp(pg?.rushYPC, 'collegeRushYPC'),
        collegeYdsPerRec: imp(pg?.ydsPerRec, 'collegeYdsPerRec'),
        collegeBestRecYds: imp(best?.bestRecYds, 'collegeBestRecYds'),
        collegeBestRecTDs: imp(best?.bestRecTDs, 'collegeBestRecTDs'),
        collegeBestReceptions: imp(best?.bestReceptions, 'collegeBestReceptions'),
        collegeBestRushYds: imp(best?.bestRushYds, 'collegeBestRushYds'),
        collegeSeasons: best?.numSeasons || 0,
        prospectGrade: prospect?.grade || 0,
        prospectPosRank: prospect?.pos_rk || 0,
        prospectOvlRank: prospect?.ovr_rk || 0,
        collegeDominatorRating: imp(adv?.dominatorRating, 'collegeDominatorRating'),
        collegeBreakoutAge: imp(adv?.breakoutAge, 'collegeBreakoutAge'),
        collegeBreakoutAgeDelta: adv?.breakoutAge && draftAge
          ? Math.round((draftAge - adv.breakoutAge) * 10) / 10 : 0,
        collegeMarketShare: imp(adv?.marketShare, 'collegeMarketShare'),
        speedScore: ss,
        collegeRecYdsPerTeamPassAtt: zap?.recYdsPerTeamPassAtt || 0,
        collegeReceptionShare: zap?.receptionShare || 0,
        collegeYdsPerTeamPlay: zap?.ydsPerTeamPlay || 0,
        collegeBreakoutScore: zap?.breakoutScore || 0,
        collegeBestRecYdsPerTPA: zap?.bestSeasonRecYdsPerTPA || 0,
        collegeRushProductionWR: zap?.rushProductionWR || 0,
        collegeEarlyDeclare: zap?.earlyDeclare || 0,
        collegeTeammateScore: ts,
        heightAdjSpeedScore: htAdjSpeedScore,
        draftCapXSpeed,
        hasCollegeStats: _hasCollege,
        hasProspectGrade: _hasProspect,
      });
    }
    return results;
  },
};

registerGroup(collegeGroup);
