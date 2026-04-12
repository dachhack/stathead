/**
 * Visits feature group: NFL Draft pre-draft "Top 30" visits.
 *
 * Teams are allowed 30 pre-draft visits with prospects each year. WalterFootball
 * has tracked these since 2013; data covers 2013-2014, 2018, 2024-2026.
 *
 * Features produced (static, per-player):
 *   numTop30Visits     — count of teams that visited this prospect
 *   logVisitCount      — log(1 + numVisits), better for modeling
 *   visitDensity       — numVisits / 32 (fraction of league that visited)
 *   hasVisitData       — 1 if the prospect appears in the visit shard
 *   visitedByDraftTeam — 1 if the drafting team visited pre-draft
 *   visitCountXDraftCap — interaction: logVisitCount * invDraftPick
 *
 * Caveats:
 *   • WF lumps Top-30 visits with private workouts, combine interviews, etc.
 *   • Coverage: 2013-2014, 2018, 2024-2026. Other years have hasVisitData=0.
 *   • Visits are used as smokescreens; raw count is noisier than combine metrics.
 */

import { registerGroup } from '../registry';
import type { FeatureGroup, PlayerKey } from '../types';

export const visitsGroup: FeatureGroup = {
  def: {
    id: 'visits',
    label: 'Pre-Draft Top-30 Visits',
    featureKeys: [
      'numTop30Visits', 'logVisitCount', 'visitDensity',
      'hasVisitData', 'visitedByDraftTeam', 'visitCountXDraftCap',
    ],
    dataDeps: ['draft'],
    scope: 'static',
  },
  compute: (ctx, _season) => {
    const results = new Map<PlayerKey, Record<string, number>>();
    const visitsByName = (ctx.data as any).visitsByName as
      | Map<string, { year: number; teams: string[] }[]>
      | undefined;

    for (const [pk, player] of ctx.players) {
      const draft = ctx.data.draftByName.get(player.normalName);
      const draftYear = draft?.season || player.season;
      const draftTeam = draft?.team || '';
      const draftPick = draft?.pick || 0;

      // Match visits to the player's draft year
      let visits: { year: number; teams: string[] } | undefined;
      const candidates = visitsByName?.get(player.normalName) || [];
      if (candidates.length > 0) {
        visits = candidates.find((v) => v.year === draftYear) || candidates[0];
      }

      const teams = visits?.teams || [];
      const numVisits = teams.length;
      const hasData = visits ? 1 : 0;
      const visitedByDraftTeam = draftTeam && teams.includes(draftTeam) ? 1 : 0;
      const logVisitCount = Math.log(1 + numVisits);
      const visitDensity = numVisits / 32;
      const invDraftPick = draftPick > 0 ? 1 / draftPick : 0;
      const visitCountXDraftCap = logVisitCount * invDraftPick;

      results.set(pk, {
        numTop30Visits: numVisits,
        logVisitCount,
        visitDensity,
        hasVisitData: hasData,
        visitedByDraftTeam,
        visitCountXDraftCap,
      });
    }
    return results;
  },
};

registerGroup(visitsGroup);
