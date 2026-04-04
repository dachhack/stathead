/**
 * Interaction feature group: cross-feature products capturing non-linear relationships.
 * Depends on other groups for the base features.
 */

import { registerGroup } from '../registry';
import type { FeatureGroup, PlayerKey } from '../types';

export const interactionGroup: FeatureGroup = {
  def: {
    id: 'interaction',
    label: 'Feature Interactions',
    featureKeys: [
      'adpXage', 'adpXyearsInLeague', 'contractXdepthRank',
      'priorPPGXage', 'adpXteamPassRate', 'adpXschemeShotgun',
      'priorPPGXsnapPct', 'ageXcontractYears',
      'targetShareXteamPassRate', 'rushAttXageDecline',
    ],
    dataDeps: ['adp', 'draft', 'contracts', 'priorStats', 'priorSnaps', 'pbp', 'depthCharts'],
    groupDeps: ['profile', 'coaching', 'priorStats', 'aging', 'contract', 'competition'],
    scope: 'seasonal',
  },
  compute: (ctx, season) => {
    const results = new Map<PlayerKey, Record<string, number>>();
    for (const [pk, player] of ctx.players) {
      // Read base features from prior group outputs
      const pf = ctx.priorFeatures.get(pk) || {};

      const a = player.adp;
      const playerAge = pf.age || 25;
      const yil = pf.yearsInLeague || 0;
      const passRate = pf.teamPassRate || 0.5;
      const shotgunRate = pf.teamShotgunRate || 0.5;
      const priorPPGVal = pf.priorPPG || 0;
      const snapPctVal = pf.priorSnapPct || 0;
      const cAPY = pf.contractAPY || 0;
      const cYearsRem = pf.contractYearsRemaining || 0;
      const depthRank = pf.depthChartRank || 99;
      const avgTgtShare = pf.priorTargetShare || 0;
      const isDecline = pf.isDeclineAge || 0;
      const priorCarries = pf.priorCarries || 0;

      results.set(pk, {
        adpXage: Math.round(a * playerAge / 100) / 10,
        adpXyearsInLeague: Math.round(a * yil) / 10,
        contractXdepthRank: Math.round(cAPY * depthRank * 10) / 10,
        priorPPGXage: Math.round(priorPPGVal * playerAge * 10) / 10,
        adpXteamPassRate: Math.round(a * passRate * 10) / 10,
        adpXschemeShotgun: Math.round(a * shotgunRate * 10) / 10,
        priorPPGXsnapPct: Math.round(priorPPGVal * snapPctVal * 10) / 10,
        ageXcontractYears: Math.round(playerAge * cYearsRem * 10) / 10,
        targetShareXteamPassRate: Math.round(avgTgtShare * passRate * 1000) / 1000,
        rushAttXageDecline: Math.round(priorCarries * isDecline),
      });
    }
    return results;
  },
};

registerGroup(interactionGroup);
