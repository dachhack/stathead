/**
 * Competition feature group: roster competition, depth chart, teammate quality.
 * This is one of the most complex groups — requires roster analysis,
 * team-level aggregation, and cross-position quality comparisons.
 */

import { registerGroup } from '../registry';
import type { FeatureGroup, PlayerKey } from '../types';
import { POSITIONS } from '../../featureTypes';

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
    dataDeps: ['rosters', 'depthCharts', 'priorStats', 'draft', 'adp'],
    scope: 'seasonal',
  },
  compute: (ctx, season) => {
    const results = new Map<PlayerKey, Record<string, number>>();
    const d = ctx.data;

    // Pre-compute team-level aggregates
    const teamTotalCarries = new Map<string, number>();
    const teamTotalTargets = new Map<string, number>();
    const priorPPRByName = new Map<string, number>();

    for (const [name, prior] of d.priorByName) {
      if (!POSITIONS.includes(prior.position)) continue;
      const team = prior.recent_team || '';
      priorPPRByName.set(name, prior.fantasy_points_ppr || 0);
      teamTotalCarries.set(team, (teamTotalCarries.get(team) || 0) + (prior.carries || 0));
      teamTotalTargets.set(team, (teamTotalTargets.get(team) || 0) + (prior.targets || 0));
    }

    // Team-position aggregation (best PPR, total PPR, top-12 status)
    const teamPosAgg = new Map<string, { bestPPR: number; totalPPR: number; hasTop12: boolean }>();
    for (const [posKey, names] of d.rosterByTeam) {
      let bestPPR = 0, totalPPR = 0;
      for (const name of names) {
        const ppr = priorPPRByName.get(name) || 0;
        if (ppr > bestPPR) bestPPR = ppr;
        totalPPR += ppr;
      }
      teamPosAgg.set(posKey, { bestPPR, totalPPR, hasTop12: bestPPR >= 200 });
    }

    // Target HHI per team
    const teamTargetHHI = new Map<string, number>();
    for (const [team, totalTgt] of teamTotalTargets) {
      if (totalTgt <= 0) continue;
      let hhi = 0;
      for (const [_name, prior] of d.priorByName) {
        if ((prior.recent_team || '') !== team) continue;
        const share = (prior.targets || 0) / totalTgt;
        hhi += share * share;
      }
      teamTargetHHI.set(team, Math.round(hhi * 1000) / 1000);
    }

    // Team pass catcher totals
    const teamPassCatcherPPR = new Map<string, number>();
    const teamElitePassCatchers = new Map<string, number>();
    for (const [posKey, names] of d.rosterByTeam) {
      const [team, pos] = posKey.split(':');
      if (pos !== 'WR' && pos !== 'TE') continue;
      for (const name of names) {
        const ppr = priorPPRByName.get(name) || 0;
        teamPassCatcherPPR.set(team, (teamPassCatcherPPR.get(team) || 0) + ppr);
        if (ppr >= 200) teamElitePassCatchers.set(team, (teamElitePassCatchers.get(team) || 0) + 1);
      }
    }

    // New arrival analysis
    const newArrivalBestPPR = new Map<string, number>();
    const newArrivalBestADP = new Map<string, number>();
    // Build ADP lookup for new arrival ADP tracking
    const adpByName = new Map<string, number>();
    for (const [_pk, player] of ctx.players) {
      adpByName.set(player.normalName, player.adp);
    }
    for (const [posKey, currentNames] of d.rosterByTeam) {
      const priorNames = d.priorRosterByTeam.get(posKey);
      if (!priorNames) continue;
      for (const name of currentNames) {
        if (priorNames.has(name)) continue;
        const ppr = priorPPRByName.get(name) || 0;
        if (ppr > (newArrivalBestPPR.get(posKey) || 0)) newArrivalBestPPR.set(posKey, ppr);
        const adp = adpByName.get(name) || 999;
        if (adp < (newArrivalBestADP.get(posKey) || 999)) newArrivalBestADP.set(posKey, adp);
      }
    }

    // Draft capital at same position
    const teamDraftedPos = new Map<string, { count: number; bestPick: number }>();
    for (const [draftName, draft] of d.draftByName) {
      if (!draft.pick || draft.season !== season) continue;
      if (!POSITIONS.includes(draft.position || '')) continue;
      const team = d.playerTeamMap.get(draftName) || '';
      if (!team) continue;
      const posKey = `${team}:${draft.position}`;
      const existing = teamDraftedPos.get(posKey) || { count: 0, bestPick: 999 };
      existing.count += 1;
      existing.bestPick = Math.min(existing.bestPick, draft.pick);
      teamDraftedPos.set(posKey, existing);
    }

    // Roster turnover per team
    const teamRosterTurnover = new Map<string, number>();
    for (const [posKey, currentNames] of d.rosterByTeam) {
      const team = posKey.split(':')[0];
      const priorNames = d.priorRosterByTeam.get(posKey);
      if (!priorNames || currentNames.size === 0) continue;
      const newCount = [...currentNames].filter(n => !priorNames.has(n)).length;
      const turnover = newCount / currentNames.size;
      if (turnover > (teamRosterTurnover.get(team) || 0)) {
        teamRosterTurnover.set(team, Math.round(turnover * 1000) / 1000);
      }
    }

    for (const [pk, player] of ctx.players) {
      const team = player.team;
      const posKey = `${team}:${player.position}`;
      const prior = d.priorByName.get(player.normalName);
      const teammates = d.rosterByTeam.get(posKey);
      const priorTeammates = d.priorRosterByTeam.get(posKey);
      const samePosCount = teammates ? teammates.size - (teammates.has(player.normalName) ? 1 : 0) : 0;
      const newArrivals = teammates && priorTeammates
        ? [...teammates].filter(n => n !== player.normalName && !priorTeammates.has(n)).length : 0;

      const priorTeamCarries = teamTotalCarries.get(team) || 1;
      const priorTeamTgt = teamTotalTargets.get(team) || 1;
      const touchShare = player.position === 'RB'
        ? (prior?.carries || 0) / priorTeamCarries
        : (prior?.targets || 0) / priorTeamTgt;
      const targetShare = (prior?.targets || 0) / priorTeamTgt;

      let bestTeammatePPR = 0;
      if (teammates) {
        for (const tm of teammates) {
          if (tm === player.normalName) continue;
          const ppr = priorPPRByName.get(tm) || 0;
          if (ppr > bestTeammatePPR) bestTeammatePPR = ppr;
        }
      }

      results.set(pk, {
        teamSamePosCount: samePosCount,
        depthChartRank: d.depthChartByName.get(player.normalName) || 99,
        priorTeamTouchShare: Math.round(touchShare * 1000) / 1000,
        priorTeamTargetShare: Math.round(targetShare * 1000) / 1000,
        newSamePosAdded: newArrivals,
        teamDraftedSamePos: teamDraftedPos.get(posKey)?.count || 0,
        draftCapitalSamePos: (() => {
          const dp = teamDraftedPos.get(posKey);
          return dp ? Math.max(0, 8 - Math.ceil(dp.bestPick / 32)) : 0;
        })(),
        teammatePriorPPR: Math.round(bestTeammatePPR * 10) / 10,
        teamWRElitePPR: Math.round((teamPosAgg.get(`${team}:WR`)?.bestPPR || 0) * 10) / 10,
        teamWRTop12: (teamPosAgg.get(`${team}:WR`)?.hasTop12 || false) ? 1 : 0,
        teamWRTotalPPR: Math.round((teamPosAgg.get(`${team}:WR`)?.totalPPR || 0) * 10) / 10,
        teamTEElitePPR: Math.round((teamPosAgg.get(`${team}:TE`)?.bestPPR || 0) * 10) / 10,
        teamRBElitePPR: Math.round((teamPosAgg.get(`${team}:RB`)?.bestPPR || 0) * 10) / 10,
        teamRBTop12: (teamPosAgg.get(`${team}:RB`)?.hasTop12 || false) ? 1 : 0,
        teamPassCatcherPPR: Math.round((teamPassCatcherPPR.get(team) || 0) * 10) / 10,
        teamElitePassCatchers: teamElitePassCatchers.get(team) || 0,
        teamTargetHHI: teamTargetHHI.get(team) || 0,
        newArrivalBestPPR: newArrivalBestPPR.get(posKey) || 0,
        newArrivalBestADP: newArrivalBestADP.get(posKey) || 0,
        teamRosterTurnover: teamRosterTurnover.get(team) || 0,
      });
    }
    return results;
  },
};

registerGroup(competitionGroup);
