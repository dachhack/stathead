/**
 * Visits feature group: NFL Draft pre-draft "Top 30" visits.
 *
 * Teams are allowed 30 pre-draft visits with prospects each year (plus
 * unlimited local visits, combine interviews, and pro-day meetings).
 * WalterFootball has tracked these since 2013; our scraper writes a flat
 * shard at public/data/feature-store/visits.json keyed by "<normalName>::<year>".
 *
 * Features produced (static, per-player):
 *   numTop30Visits   — count of teams recorded as visiting this prospect
 *   hasVisitData     — 1 if the prospect appears in the visit shard, else 0
 *   visitedByDraftTeam — 1 if the drafting team visited this player, else 0
 *
 * Caveats:
 *   • WF lumps Top-30 visits with private workouts and combine interviews —
 *     the count is "pre-draft contact" broadly, not strictly Top-30.
 *   • Visits are used as smokescreens. High counts correlate with draft
 *     stock but the signal is noisier than combine metrics.
 *   • Coverage starts in 2013. Earlier drafts will have hasVisitData=0.
 */

import { registerGroup } from '../registry';
import type { FeatureGroup, PlayerKey } from '../types';

export const visitsGroup: FeatureGroup = {
  def: {
    id: 'visits',
    label: 'Pre-Draft Top-30 Visits',
    featureKeys: ['numTop30Visits', 'hasVisitData', 'visitedByDraftTeam'],
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
      // Rookie-year lookup: visits are recorded per draft class, so key on
      // the draft season (falls back to player.season for pre-draft rookies
      // whose draft row doesn't exist yet).
      const draftYear = draft?.season || player.season;
      const draftTeam = draft?.team || '';

      // A given prospect may have visits recorded under multiple years if
      // the scraper was run multiple times; take the record matching the
      // draft year, else the most recent.
      let visits: { year: number; teams: string[] } | undefined;
      const candidates = visitsByName?.get(player.normalName) || [];
      if (candidates.length > 0) {
        visits = candidates.find((v) => v.year === draftYear) || candidates[0];
      }

      const teams = visits?.teams || [];
      const visitedByDraftTeam =
        draftTeam && teams.includes(draftTeam) ? 1 : 0;

      results.set(pk, {
        numTop30Visits: teams.length,
        hasVisitData: visits ? 1 : 0,
        visitedByDraftTeam,
      });
    }
    return results;
  },
};

registerGroup(visitsGroup);
