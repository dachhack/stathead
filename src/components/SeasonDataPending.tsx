// Shown when a season-partitioned nflverse feed has not been published yet.
//
// nflverse posts rosters and depth charts before a season starts, but anything
// derived from games played — snap counts, injuries, weekly stats, charting —
// only appears once Week 1 has happened. Preseason that is the normal state of
// the upcoming season, so it should read as "not yet", not as a failure.
export function SeasonDataPending({ season, what }: { season: number; what: string }) {
  return (
    <div className="empty-state">
      <h3>No {season} {what} yet</h3>
      <p>
        nflverse publishes {what} from games played, so the {season} file appears
        once Week 1 is in the books. Choose an earlier season above to see
        completed data.
      </p>
    </div>
  );
}
