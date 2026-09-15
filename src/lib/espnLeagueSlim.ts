/**
 * The slice of an ESPN fantasy league payload the import reads. Shared by
 * workers/espn-news-proxy (which applies it before replying — the raw payload
 * is several MB of stats, rankings and notification settings) and the tests,
 * which feed a raw ESPN payload through it and then through the importer.
 */

type J = Record<string, unknown>;
const obj = (v: unknown): J => (v && typeof v === 'object' ? (v as J) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function slimEspnLeague(raw: unknown): J {
  const data = obj(raw);
  const settings = obj(data.settings);
  const scoring = obj(settings.scoringSettings);
  const draft = obj(settings.draftSettings);
  return {
    id: data.id, seasonId: data.seasonId, scoringPeriodId: data.scoringPeriodId,
    settings: {
      name: settings.name, size: settings.size, isPublic: settings.isPublic,
      rosterSettings: { lineupSlotCounts: obj(settings.rosterSettings).lineupSlotCounts },
      scoringSettings: {
        scoringItems: arr(scoring.scoringItems).map((i) => {
          const it = obj(i);
          return { statId: it.statId, points: it.points, pointsOverrides: it.pointsOverrides };
        }),
      },
      draftSettings: { keeperCount: draft.keeperCount, keeperCountFuture: draft.keeperCountFuture, type: draft.type },
    },
    members: arr(data.members).map((m) => {
      const mm = obj(m);
      return { id: mm.id, displayName: mm.displayName, firstName: mm.firstName, lastName: mm.lastName };
    }),
    teams: arr(data.teams).map((t) => {
      const tt = obj(t);
      const record = obj(obj(tt.record).overall);
      return {
        id: tt.id, name: tt.name, abbrev: tt.abbrev, location: tt.location, nickname: tt.nickname,
        owners: tt.owners, primaryOwner: tt.primaryOwner,
        record: { wins: record.wins, losses: record.losses, ties: record.ties, pointsFor: record.pointsFor, pointsAgainst: record.pointsAgainst },
        roster: arr(obj(tt.roster).entries).map((e) => {
          const ee = obj(e);
          const pl = obj(obj(ee.playerPoolEntry).player);
          return {
            playerId: ee.playerId, lineupSlotId: ee.lineupSlotId,
            player: { id: pl.id, fullName: pl.fullName, defaultPositionId: pl.defaultPositionId, proTeamId: pl.proTeamId, injuryStatus: pl.injuryStatus },
          };
        }),
      };
    }),
  };
}
