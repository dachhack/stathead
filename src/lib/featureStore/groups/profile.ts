/**
 * Profile feature group: ADP, age, years in league, draft capital.
 * These are derived from ADP data and draft records.
 */

import { registerGroup } from '../registry';
import type { FeatureGroup, PlayerKey } from '../types';
import { makePlayerKey } from '../types';

export const profileGroup: FeatureGroup = {
  def: {
    id: 'profile',
    label: 'Player Profile',
    featureKeys: [
      'adp', 'adpRound', 'age', 'yearsInLeague',
      'nflDraftRound', 'nflDraftPick', 'logDraftPick', 'invDraftPick',
      'draftPickXEarlyDeclare',
    ],
    dataDeps: ['adp', 'draft', 'college'],
    scope: 'seasonal',
  },
  compute: (ctx, season) => {
    const results = new Map<PlayerKey, Record<string, number>>();
    for (const [pk, player] of ctx.players) {
      const draft = ctx.data.draftByName.get(player.normalName);
      const draftAge = draft?.age || 0;
      const draftYear = draft?.season || 0;
      const age = draftAge > 0 && draftYear > 0 ? draftAge + (season - draftYear) : 0;
      const pick = draft?.pick || 300;
      const zap = ctx.data.collegeZapByName.get(player.normalName);
      const earlyDeclare = zap?.earlyDeclare || 0;

      results.set(pk, {
        adp: player.adp,
        adpRound: Math.ceil(player.adp / 12),
        age,
        yearsInLeague: draft ? season - draft.season : 0,
        nflDraftRound: draft?.round || 8,
        nflDraftPick: pick,
        logDraftPick: Math.log(pick),
        invDraftPick: 1 / pick,
        draftPickXEarlyDeclare: earlyDeclare * (1 / pick),
      });
    }
    return results;
  },
};

registerGroup(profileGroup);
