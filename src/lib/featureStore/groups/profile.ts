/**
 * Profile feature group: ADP, age, years in league, draft capital.
 * Age and years in league come from the draft record when the player was
 * drafted and from the roster (birth date / entry year) otherwise — see
 * src/lib/playerBio.ts. Draft capital is draft-table only.
 */

import { registerGroup } from '../registry';
import type { FeatureGroup, PlayerKey } from '../types';
import { resolvePlayerAge, resolveYearsInLeague } from '../../playerBio';

export const profileGroup: FeatureGroup = {
  def: {
    id: 'profile',
    label: 'Player Profile',
    featureKeys: [
      'adp', 'adpRound', 'age', 'yearsInLeague',
      'nflDraftRound', 'nflDraftPick', 'logDraftPick', 'invDraftPick',
      'draftPickXEarlyDeclare',
    ],
    dataDeps: ['adp', 'draft', 'college', 'rosters'],
    scope: 'seasonal',
  },
  compute: (ctx, season) => {
    const results = new Map<PlayerKey, Record<string, number>>();
    for (const [pk, player] of ctx.players) {
      const draft = ctx.data.draftByName.get(player.normalName);
      const bio = ctx.data.rosterBioByName.get(player.normalName);
      const age = resolvePlayerAge(draft, bio, season, 0);
      const pick = draft?.pick || 300;
      const zap = ctx.data.collegeZapByName.get(player.normalName);
      const earlyDeclare = zap?.earlyDeclare || 0;

      results.set(pk, {
        adp: player.adp,
        adpRound: Math.ceil(player.adp / 12),
        age,
        yearsInLeague: resolveYearsInLeague(draft, bio, season),
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
