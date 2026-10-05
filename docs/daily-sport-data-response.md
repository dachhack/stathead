# Daily-sport data: Stathead's response to Drip Fantasy

2026-10-05. Answers Drip's "Daily-sport data: sources, risks and Stathead
requirements" (Oct 5, 2026), which asks Stathead to serve NHL, MLB, NBA and
WNBA schedules, box scores, directories, season lines, ADP and a crosswalk
behind one authenticated API.

## Update, 2026-10-05 (later): built

The service exists: `workers/stathead-sports`, contract in
`docs/daily-sport-service.md`. Phases 1 to 3 of the plan below are done
(daily bulk, crosswalk, schedules and finals), with two changes of design
from the first draft:

- **NBA and WNBA run on ESPN, not the league CDNs.** The CDNs refuse requests
  from datacenter addresses and serve no past day; ESPN's scoreboard and box
  score endpoints serve both leagues for any date, so NBA and WNBA replay
  works on day one and both sports key on ESPN ids. Sleeper ids ride in the
  crosswalk for Drip's NBA pools.
- **Reads are served from a store the daily job fills**, and only the slate
  for a date and a box score not yet stored go to the feed, cached 60 s.
  Final NBA and WNBA box scores are materialised into monthly shards (1,316
  NBA and 654 WNBA finals for the two current seasons in under a minute) and
  summed into season lines; finals are re-read for three days and a changed
  line sets `revised_at`.

Probe results that settle two open questions:

- **WNBA ADP (question 4): not available.** ESPN's WNBA fantasy game exposes
  `averageDraftPosition` and had real boards in 2024 and 2025, but the 2026
  board is a sentinel (every player at 54.0) and will stay so until the next
  draft window. Yahoo runs no WNBA fantasy game (no game key, no host), and
  FantasyPros has no WNBA ADP page. With one source at best there is no
  blend to serve, so the WNBA ADP endpoint returns an empty board.
- **Yahoo as a market elsewhere: through FantasyPros only.** Yahoo's own
  draft-analysis pages are rendered client-side and its API needs OAuth, so
  Yahoo ADP for NBA, NHL and MLB comes in as a FantasyPros column. The blends
  today: NHL 262 players (Yahoo via FantasyPros, ESPN direct), NBA 194 (same
  two), MLB 587 (six FantasyPros columns; ESPN opens in spring).

Against Drip's acceptance list, from the dry runs: NHL directory 1,072 (885
today), MLB 1,841 (1,662), both supersets because anyone with a line this
season or last is kept; NHL ADP 262 of FantasyPros' 263 rows matched, MLB 587
of 597; every box-score id in the sampled games resolves in its directory.
Not yet done: the shadow-read week itself, which needs Drip's fixture days and
pool key lists.

## Short version

- **Stathead can build this, but it is a new service, not an extension of
  the NFL tools.** Everything Stathead serves today is either a daily
  snapshot committed to `public/data/` and published with the site, or a
  stateless MCP tool that fetches an upstream on demand. There is no REST
  API, no bearer auth, no database and no process that runs every minute.
  Five of the six requested endpoints fit the daily-snapshot pattern with
  little new infrastructure. The sixth, live box scores every 60 s, does not,
  and needs an always-on poller and a store.
- **Moving to Stathead does not move the legal risk off Drip's side unless
  someone buys a license.** Stathead holds no data contracts. For these four
  sports it would read the same public league APIs Drip reads today, under
  the same terms. Stathead's own source policy (`DATA_SOURCES.md`) files such
  feeds under "query it yourself, don't rebundle", and redistributing live
  box scores to end users is exactly the use that tier warns about. If the
  contractual question is the one Drip most wants solved, the answer is a
  licensed feed (Sportradar, SportsDataIO, Stats Perform and the like) that
  one of us pays for, with Stathead in front of it. That is a budget
  decision for Drip, not a build decision for Stathead.
- **One stable id across all endpoints is the thing Stathead is best placed
  to deliver**, and the recommendation is a Stathead-owned opaque id with
  every league and platform id in the crosswalk (question 2 below).
- **ADP will be a Stathead blend of two or more sources, never a single
  source's number**, under the standing third-party rule. That is the shape
  Drip asked for, with one caveat on WNBA below.

## What Stathead is today

| Property | Today (NFL) | What the request needs |
|---|---|---|
| Delivery | Committed JSON/CSV snapshots on the site, plus MCP (stdio on npm, Streamable HTTP on a Cloudflare Worker) | Versioned REST, JSON plus jsonl/csv bulk |
| Auth | None | Bearer token |
| Cadence | GitHub Actions cron (best-effort) for daily pulls; a Cloudflare cron Worker kicks the 20-minute injury refresh because Actions drops runs | 60 s while any game is live |
| State | Git is the store; the MCP server is stateless | Live game state, revision tracking, history for two to five seasons |
| Sports | NFL and college football | NHL, MLB, NBA, WNBA |
| Ids | nflverse `gsis_id` with a published crosswalk (Sleeper, ESPN, PFR, Yahoo, PFF and others) | A stable id per player across six endpoints and four sports |
| Blends | StatHead ADP (FantasyPros, Sleeper, FFC, freshness-weighted, two-source minimum) | The same, per sport |

The gap is the live path. Everything else is pattern reuse.

## Endpoint by endpoint

Priority order is Drip's.

### 1. Schedule

Fits. One daily pull per sport writes the season calendar (every game, date,
home, away, start time) and the day's statuses update on the live poller's
cadence. Upstream: NHL `api-web.nhle.com` schedule, MLB `statsapi.mlb.com`
schedule, NBA and WNBA CDN scoreboards (which, note, serve no past-season
day, so NBA and WNBA history has to come from a different endpoint or be
accumulated forward from day one). Canonical tricodes per sport will be
published once, with the alias table (NJD/NJ, GSW/GS, UTA/UTAH, CWS/CHW,
AZ/ARI, WSH/WAS, ATH/OAK) applied on Stathead's side.

History: NHL and MLB public APIs serve prior seasons, so two seasons of
schedule is a backfill job. NBA and WNBA past schedules are available from
other public endpoints but past box scores are the hard case (see 2).

### 2. Box score

The one endpoint that is new infrastructure. Design, if we go ahead:

- A Cloudflare Worker on a one-minute cron reads the day's schedule from the
  store, fetches a box score for every live game, normalises it to the
  dictionary below, and writes it to a KV or D1 store with `as_of`. Finals
  are re-read for a fixed window (72 h proposed) and a changed line gets
  `revised_at`. Reads are served from the store, never passed through to the
  upstream, so Drip's polling never touches a league host.
- Live (in-game) lines are in scope under that design; finals-only would be
  the same code with a longer cron.
- Dictionaries: Stathead will serve Drip's field ids exactly as listed
  (NBA/WNBA `min pts fgm fga ftm fta tpm tpa oreb dreb reb ast stl blk tov pf`;
  NHL skater and goalie; MLB hitter and pitcher), with the three known traps
  handled at normalisation: innings as outs, goalie time on ice as decimal
  minutes, power-play assists separated from assists (from the NHL realtime
  report, not the summary).
- History for replay: NHL and MLB past box scores exist upstream and can be
  backfilled. NBA and WNBA past-season box scores are not served by the CDN;
  Stathead would accumulate them from the day it starts polling, and look at
  the stats.nba.com endpoints for backfill, which have their own header and
  rate quirks. Honest answer: NBA replay on day one is not guaranteed.

### 3. Directory

Fits the daily pattern Stathead already runs for Sleeper NFL players. One
bulk pull per sport per day, plus an hourly injury refresh on game days via
the same cron Worker that dispatches the NFL injury refresh. Coverage rule
as Drip specified: active roster, plus anyone with a line this season or
last, so injured, suspended and minor-league players stay. The current
adapters' "keep the last good row on a failed read" behaviour is the right
default and will be the rule here too: a failed upstream call never blanks a
directory, and every row carries `source` and `as_of`.

### 4. Season lines

Fits. Daily bulk per sport, current and prior season first, five seasons as
a backfill. MLB per-position games played rides on the season line from the
MLB fielding stat group, so Drip's 10-game eligibility rule can run
unchanged.

### 5. ADP

Fits the existing StatHead ADP code path (`statheadAdpRows`, two-source
minimum, freshness and confidence weights). Per sport the candidate inputs
are FantasyPros (HTML, the same parser fragility Drip has, but on one side
of the fence and tested daily), ESPN fantasy ADP, Yahoo where reachable, and
Sleeper for the sports Sleeper runs. Output is `player_id, adp, sources,
as_of` with no per-source column, exactly the shape Drip listed. Two
caveats:

- Under Stathead's third-party rule a sport with only one reachable ADP
  source gets **no ADP endpoint** rather than a pass-through. Drip's
  acceptance test (rank correlation against FantasyPros of 0.95 or better)
  is run on Drip's side against a source Drip reads, which is fine; Stathead
  will not return FantasyPros's numbers.
- WNBA: ESPN and Yahoo both run WNBA fantasy games as of the 2025 season, so
  a two-source blend looks possible, but neither has been probed yet. Treat
  "WNBA ADP exists" as to-be-verified, not promised.

### 6. Crosswalk

The most valuable piece and the one Stathead should own outright. There is
no open crosswalk for these sports the way nflverse provides one for the
NFL, so it would be built from: Sleeper's player files (which carry ESPN,
Yahoo and other platform ids for the sports Sleeper runs), ESPN athlete ids
from rosters, league ids from the directories, and name plus team plus
birth-date matching for the rest, with a reviewed exceptions file. Drip's
existing keys (Sleeper for NBA, league ids for NHL and MLB, ESPN for WNBA)
each become one column, so migration is a join, and the acceptance target
(every player in a Drip pool resolves) is checkable before the switch.

## Answers to the open questions

1. **Upstream and redistribution rights.** No license today. Stathead would
   read the public league APIs (NHL, MLB, NBA and WNBA CDNs), Sleeper and
   ESPN public endpoints, and FantasyPros, the same hosts Drip reads. There
   is no contractual right to redistribute live box scores from any of them.
   Stathead takes on the operational risk (parsers, headers, aliases,
   outages) and gives Drip one party to call. It cannot take on the legal
   risk. If that is the priority, the path is a paid licensed feed and the
   open question becomes who pays.
2. **Player id.** Stathead's own opaque id (for example `sh_nba_000123`),
   stable for life, with `nba_id` / `nhl_id` / `mlb_id` / `wnba_id`,
   `sleeper_id`, `espn_id`, `yahoo_id` and `fantasypros_slug` in the
   crosswalk. League ids are not usable as the primary key across sports:
   WNBA players have no single league id that agrees between the ESPN
   directory and the WNBA CDN, and NBA players' Sleeper and NBA ids already
   diverge in Drip's pools.
3. **Live box scores.** In scope under the Worker design above, at the
   60 s cadence Drip asked for. The cost is the always-on poller and store;
   finals-only would save little once that exists.
4. **WNBA ADP.** Possibly, from ESPN and Yahoo WNBA fantasy. To be verified
   with a probe before it is counted on. If only one source resolves,
   Stathead serves no WNBA ADP, by policy.
5. **History on day one.** NHL and MLB: two seasons of schedule and box
   scores and five of season lines are backfill jobs against upstreams that
   serve them. NBA and WNBA: schedules yes, season lines yes (Sleeper for
   NBA, ESPN for WNBA), past box scores not guaranteed; the CDN serves none
   and the alternative endpoints need evaluation.
6. **First-party projections.** Not on day one. Stathead's NFL weekly
   projection is a season model split across the schedule with
   matchup, availability and depth-chart adjustments measured on ten
   seasons of NFL data. A daily-sport equivalent needs the season lines
   (endpoint 4) and the directory with injuries (endpoint 3) in place
   first, then its own validation. The `get_weekly_projections` shape (per
   game, `as_of`, stat components) is the right target and can be committed
   to once the inputs exist.
7. **Stat corrections.** Finals will be re-read for 72 h after the game and
   a changed line gets `revised_at`; the window is a parameter. NHL and MLB
   do post scoring changes after the final; NBA box scores are corrected
   less often. Drip chooses whether to re-score.
8. **Rate limits and sandbox.** Reads are served from Stathead's store, not
   proxied, so the budget is Stathead's own hosting rather than an upstream
   quota. A staging token for the shadow-read week is straightforward once
   auth exists.

## What Stathead will not do

- Return a third-party ranking, ADP or projection raw, per
  `docs/third-party-data-policy.md`. Box scores, schedules and directories
  are facts, not rankings, and are not covered by that rule; ADP is.
- Proxy Drip's calls to a league host. Every read is answered from
  Stathead's own store so the cadence and the headers are Stathead's
  problem.
- Promise NBA or WNBA replay history before the backfill path is proven.

## Proposed phasing

Each phase is independently useful and each sport switches independently
behind Drip's `SPORT_PROVIDER` setting.

1. **Daily bulk, static.** Directory, season lines, season calendar and ADP
   per sport as daily jsonl files under a versioned path on the site, built
   by GitHub Actions like the NFL snapshots. No auth yet. Enough for Drip to
   start shadow reads on four of the eight needs and to validate the
   crosswalk.
2. **Crosswalk to 100 %.** Built in phase 1, closed against Drip's live
   pools in this one.
3. **Schedule and finals.** The cron Worker and store, at a slow cadence:
   day's schedule, statuses, final box scores, `revised_at`. Bearer auth
   lands here, since this is the first endpoint that costs per request.
4. **Live lines.** The same Worker at 60 s during live games.
5. **History backfill.** Two seasons of NHL and MLB schedule and box
   scores; five of season lines; NBA and WNBA as far as the alternative
   endpoints allow.
6. **Projections**, if wanted, after a season of lines has accumulated.

Phases 1 and 2 reuse existing Stathead machinery and are the cheap part.
Phases 3 and 4 are the new service.

## What Stathead needs from Drip

- A decision on question 1: public feeds with the risk acknowledged, or a
  licensed feed and who pays for it.
- Agreement that phase 1 can be served as static files without auth for the
  shadow-read week, so parity testing starts before the Worker exists.
- The fixture corpus in `server/test/fixtures/sports` (box scores, season
  reports, rosters, ADP pages, calendars) and the `check:sports` runner, so
  Stathead can assert agreement with the same days Drip does.
- The current Drip pools' key lists per sport, for the crosswalk coverage
  check.
