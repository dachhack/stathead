# STATUS

> Orchestrator-facing status. Keep this short and current — `meta`'s
> `/standup` reads it. In-repo WIP details belong in HANDOFF.md.
> Goal / Phase / Cadence are mirrored into `meta/projects.md`.

## Goal

A full-stack NFL fantasy football research workbench — React app, daily
data-snapshot pipelines, ML projection/value models, and an MCP server —
covering redraft, dynasty, and best-ball/SFB formats; currently being
hardened for public launch at stathead.app.

## Current phase

2026 draft-season feature work: Scott Fish Bowl 16 scoring + cheatsheet
research tab merged to the default branch
(`claude/nfl-fantasy-workbench-6D1yd`); SFB16 live-draft support in use.

## Cadence

Near-daily July–December (draft season through playoffs); maintenance-only
in the offseason. Automated daily data snapshots commit regardless.

## Last worked

2026-09-24 (in-season re-projection live for the MCP) — the headless pool
builder (`scripts/build-projection-pool.ts`) never passed `currentStats`,
so the committed `projection-base-2026.json` — and therefore
`get_projections`, `get_weekly_projections`, ROS totals and trade/waiver
values — stayed preseason (`inSeason: null`) while the site's Projections
tab blended. It now loads 2026 stats; 367 players blend after week 2
(mean weight 0.29). The blend also only counts a week once every game in
it is final (a Thursday game no longer charges 30 teams a missed game),
and availability counts the player's TEAM games, so a bye is not a missed
game.

2026-09-15 (Swap Meet link + editable versions) — `?tab=swap-meet` (and
`#/swap-meet`) opens the Swap Meet page directly; the page has a "Copy a
link to this page" button (`parsePageRoute` in `src/lib/hashRoute.ts`,
read for the initial tab and on hashchange, then stripped from the bar).
In the composer every version's pieces can be changed before the meet is
created ("Change the pieces": remove any piece, add one from either
roster by search), a version can be added by hand, and each change is
re-priced and re-read for both sides (`revise` from the finisher). The
finisher's throw-ins are suggestions now, not the deal. Tests: swap-meet
85, trade-finisher 79; Playwright drive of the deep links and the editor
against Sleeper fixtures.

2026-09-15 (weekly actuals) — the weekly projections carry actuals. The
builder stamps `act` / `actRec` (actual PPR points and receptions per
REG week from the nflverse game logs, weeks <= playedThrough only, null
where the player did not play) on every skill row, with an `actualsNote`
on the doc. The site's Weekly Projections tab has an Actual column next
to the projection (re-scored for half/std from the receptions; green at
or above projection, amber below, DNP for a played week without a game),
and the MCP's `get_weekly_projections` adds `actual` to week mode (only
once the week is final) and to a player's strip (MCP 1.0.92). Local
validation: `WEEKLY_PLAYED_THROUGH=1 python3
scripts/build-weekly-projections.py` forces the played week when the
checkout's games snapshot is stale.

2026-09-15 (Swap Meet without Sleeper) — two more ways to start a meet.
**ESPN leagues**: the Trade Finisher has a "League from: Sleeper | ESPN"
toggle; ESPN takes a league id or league URL and a season, loads public
leagues as is, and a "Private league" tick reveals `espn_s2` + `SWID`
fields (the manager's own cookies, sent once through
`workers/espn-news-proxy`'s new `GET /league/<season>/<id>` route as
headers → upstream Cookie, never stored or cached, kept in the tab's
sessionStorage). `src/lib/espnLeague.ts` turns the slimmed payload into
the same `LeagueImport` the Sleeper import yields (Sleeper-style roster
positions from slot counts, scoring keys from stat ids incl. a TE-only
reception override → `bonus_rec_te`, keepers → dynasty with a checkbox
override); players resolve to Sleeper ids through the crosswalk by ESPN
id (`lookupByEspnId`). ESPN publishes no future picks, so each team gets
its own picks (noted in the UI). `npm run test:espn-league` (25) runs the
importer against a real public-league payload fixture. **By hand, no
league**: Swap Meet's "Start a meet" toggles between "From a league" and
"By hand" (`ManualMeetBuilder`): name both sides, format + TE premium,
pick pieces off the dynasty board (`BoardPicker` over `boardAssets`:
players + the board's Early/Mid/Late pick rows), pitch, create. Such a
meet has `league.source = 'manual'`; sheets show board values and the
fairness verdict only (`valueOnlyEval`, `AnyEval` on `OfferSheet` /
`TradeFront`), no needs / lineup / roles, and the meet page's editor
picks counters off the same board. Tests: swap-meet 77, trade-finisher
79.

2026-09-15 (Swap Meet as its own feature) — Dynasty → **Swap Meet** is a
tab of its own (`src/components/SwapMeetHome.tsx`): the meets this device
opened or joined (copy links, forget), "open a meet from a link", and
"Build the trade" — the Trade Finisher in `mode="swap"` (open by default,
the composer at the end, no calculator hand-off). The Trade Calculator's
finisher no longer embeds the composer; it offers "Send to <partner> ·
Swap Meet →", and the finisher's sessionStorage selections carry over.
Home page lists Swap Meet. Sheet formatting: `.sm-sheet` is a size
container that stacks its packages under 520px wide (a three-up composer
grid, a phone, a narrow window), and asset names wrap only at spaces and
hyphens — the composer on a 1000px screen was breaking "Wan'Dale
Robinson" into four lines.

2026-09-15 (week 2 data review) — three fixes from reviewing the site's
week 2 rosters, injuries and projections.
1. Stale injury designations. The MCP weekly tool applied any report at or
   before the requested week, so the week-1 report zeroed Brock Bowers, Tua
   and TreVeyon Henderson for week 2 until Wednesday's report landed. Now a
   report is a multiplier (Out → 0, Doubtful ×0.25) only for its OWN week;
   an earlier week's report shows as an unconfirmed flag with points
   untouched, and next-man-up redistribution waits for the real report. The
   weekly builder now stamps `inj` {status, week} on rows and
   `injuryReportWeek` on the doc, and the site's Weekly Projections tab
   applies the same rule (solid chip for the report week, dashed "wk N?"
   flag otherwise) — the two consumers agree again. MCP 1.0.91.
2. Reserve / exempt players in the pool. `buildProjectionPool` dropped
   EXE/DEV/RET/CUT and benched RES, and benched players mostly lost the
   per-team cut, so 69 skill players (A.J. Brown, Josh Jacobs, James Conner,
   Tank Dell, Zach Charbonnet…) had no row and every dynasty page read them
   as zero. Now RES and EXE are benched, never enter the team pie (their
   prior usage would claim volume they are not there to take), and get a
   conditional row — their own prior-season per-game line over ONE game
   (`benchedConditionalRow`, `rosterStatus` on the row, `status` via
   `fields` on get_projections) — skipping the ML anchor, the depth-chart
   line reassignment and the in-season blend. The weekly builder zeroes
   their weeks as before. No prior season (a rookie on IR) still means no
   row. DEV stays dropped.
3. Waiver wire ranking. `get_sleeper_waiver_wire` sorted by a ppg that is
   conditional on playing and returned thirty backup QBs. It now joins
   projected games and rest-of-season points (`ros_pts`, from the weekly
   artifact), adds `sort_by: ros`, and `ppg` ranks players projected for
   at least `min_games` (8) first.

2026-09-15 (latest) — Trade reads: goals, now vs later, and roster
construction. `evaluateOffer` now returns a `SideRead` per team
(`myRead` / `partnerRead`): every piece's role on the roster it leaves
(before) or joins (after) via `rosterRole` — weekly starter with its slot
and marginal pts/wk over the next man up, next man up, or surplus depth
that never starts (your QB4 in superflex, your WR5) — plus the best-lineup
change in pts/wk (now), dynasty value received minus sent, the same at the
120-day forecast horizon, and the age delta (later), and a goal-weighted
fit with a word (Great / Good / A wash / Poor / Bad). `goalFit` now blends
today's board with the forecast for the long-term term; win-now leans on
the lineup, a rebuild on later value and youth. `buildFinisherTeams`
takes `laterLogReturnByKtcId` (the Trade Finisher loads the display-scale
forecasts and passes the 120-day log-returns); `FinisherAsset.valueLater`
carries it into a meet. `readLines(read, you)` writes the read in words
("Rome Odunze starts at WR for you (+12.6 pts/wk over the next man up)",
"Geno Smith (QB4) was surplus depth that never started", "Now: lineup
+0.3 pts/wk · Later: value −1,000, −100 on the 120-day forecast, 7.5 yrs
younger"); `partnerPositives` and the tags pick up starters and surplus.
UI: the offer sheet's front has an assessment block per side (the
proposer sees both, the partner only theirs; three lines compact, all
when Details is open), the finisher's verdict card shows both reads, the
variant cards a "You: Great · Them: A wash" line, the composer cards a
fit strip. Tests: `test:trade-finisher` 72 (+22), incl. the QB4-for-a-
weekly-starter case reading Great for a win-now team.

2026-09-15 (later) — Swap Meet offer sheets are now pages from a dossier:
cream paper on the dark desk with a grain overlay, a manila header band
with the version as a file tab ("Offer sheet · filed by X · re: v1 · 2 h
ago"), typewriter labels, serif names, square passport photos, ruled lines between pieces, a double-ruled
rubber stamp (Deal / Your call / Passed / Countered / Pending / Void), the
pitch on a yellow sticky note, and ink-outline buttons. The whole look is
CSS: `.sm-sheet` re-scopes the theme variables to a paper palette so the
shared pieces (position badges, buttons, inputs, player links) set in ink
without changes; the inline colours use `GIVE_INK` / `GET_INK` / `INK` /
`PAPER_VERDICT_COLOR` from `offerStyle.ts`. The composer's candidate
cards share the look. On phones the packages stack and the ⇄ glyph hides
(it used to collide with the header).

2026-09-15 (later) — Swap Meet: "since you last looked". The worker's GET
now returns `lastSeen` (that side's read receipt from before the read) and
the page keeps it as a baseline: a strip under the move banner says what
the other side did ("put v3 on the table, passed on v1 and left a note",
Got it to dismiss), touched sheets get a New badge and an amber ring, new
notes a dot, the Details summary counts new notes, and the tab title
carries the count; arrivals while the page polls are marked the same way.
`newSince` / `describeNewSince` in `swapMeetCore.ts` (72 checks). The
composer's candidate cards now use the sheet front (`TradeFront`, exported
from `OfferSheet.tsx`): headshots, balance bar, verdict, the pitch box
inline. Worker change ships when `workers/**` lands on the dev branch.

2026-09-15 — Swap Meet offer sheets refocused on the pieces. The front of
each sheet is now the trade: 54px headshots, 15px names, team/age line,
per-asset values, the balance bar with the verdict, the pitch clamped to
two lines, and only the decision buttons (I'd accept / Pass / Counter, or
"Copy deal" on an agreed sheet). Everything else — lineup read, tags,
both votes, the note thread, and the author's Revise / Mark final /
Withdraw plus the per-version note box — folds behind a `Details` toggle
whose summary line counts notes, votes and tags. Mobile scales the
avatars to 46px. Handoff for the next session: `docs/handoff-swap-meet.md`.

2026-09-15 — Swap Meet round two: a negotiation, not a list. The model
(`src/lib/swapMeetCore.ts`) now records counter lineage (`counterOf`),
"final offer" flags, and read receipts (`seen`, stamped by the worker on a
keyed read at most every 5 min), and derives per-seat state:
`optionStatus` (agreed / countered / declined / passed / your call /
waiting), `whoseMove`, `bestCandidate` (closest to a deal), and
`chatSummary` (paste-able state of the table). The page renders each
version as an offer sheet (`src/components/swap/OfferSheet.tsx`): the two
packages with headshots and team logos, a value balance bar, the pitch
as a quote, both votes, a rotated status stamp, badges for "closest to a
deal" / "final offer" / "agreed", lineage ("↩ counter to v1"). Tailored
seats: a move banner ("Your move" / "Waiting on X · opened 2h ago" /
"Deal"), authors get Revise / Mark final / Withdraw, the other side gets
I'd accept / Pass / Counter with a note; the proposer's needs cards fold
away; "Copy summary for chat". 62 model checks; e2e driven in Playwright.

2026-09-13 (later) — Feature directionality on the prospect cards. A
pick-177 WR's Log(Draft Pick) rendered as a 76th-percentile green bar:
precompute-features inverted a short list of lower-is-better features
when storing percentiles and the card inverted a longer list again, so
the overlap (draft pick, age, timed drills) flipped twice. The store now
keeps RAW percentiles (mid-rank for ties, so a zero shared with half the
class sits at 50, not 100) and `LOWER_IS_BETTER` in prospectScores.ts is
the only place direction lives (breakout age, guide ranks/round and
same-position teammates added). Guide/scout counts read "no data" when
that source has no profile, flags and class constants are never bars.
`npm run test:feature-direction` checks the list against the registry,
the store against the raw-percentile contract, late picks against the
bar, and both against the career model's coefficient signs (all agree
where the weight is meaningful). Score store rebuilt.

2026-09-13 — Combine provenance on prospect cards. Nate Boerkircher's card
showed a full combine line he never ran: the 40 and weight were the April
prospect sheet's projections, the five other drills were the TE position
average (identical for all 27 TEs), and RAS / Speed Score were derived from
those. Two masks now travel with every 2026 rookie's features
(`combineMeasuredMask` = nflverse results, `combineEstimatedMask` = sheet
figures; neither = position average; `src/lib/combineProvenance.ts`,
`npm run test:combine-provenance`). precompute-features follows the
training rules on both prospect paths: a measured result beats the sheet
(this also fixed Kenyon Sadiq, whose sheet estimates had been overriding
his real 241 / 4.39 / 26 bench / 43.5 vert), `hasCombineData` means "has
an nflverse combine record", RAS is from measured drills only. Cards
show `est.` (dimmed bar) for sheet figures, `not tested` / `no RAS` for
fills, and count the drills tested. Score store rebuilt; class-wide
predicted PPG moved a mean 0.03 (max 0.4).

2026-09-12 (later) — **Swap Meet by StatHead**: a trade negotiation two
managers share by link. From the Trade Finisher, "Send to <partner>"
picks which versions go on the table (each with a pitch drafted from the
finisher's edits and tags, in team names) plus an opening note, and
creates a meet: two capability links, one per side, no accounts. The
meet page (`#/swap/<id>?k=…`, `src/components/SwapMeetView.tsx`) shows
both rosters' needs, every version with the finisher's fairness and
lineup read recomputed from a league snapshot stored with the meet, each
side's vote (would accept / pass / undecided), notes per version and
general, an editor to counter or revise (suggested finishes ranked from
the editing side's goal), withdraw, close/reopen, and a Deal banner when
both sides accept the same version. Backend: `workers/swap-meet`
(Cloudflare Worker + KV, 120-day TTL) running the shared pure model
`src/lib/swapMeetCore.ts` (`npm run test:swap-meet`); deploy-workers.yml
created the KV namespace on the first deploy (run 34710950316, green);
the live service at `https://swap-meet.dachhack.workers.dev` passed a
create → vote → deal → viewer/403/CORS smoke test from the session.

Earlier today — Trade Finisher in the Trade Calculator
(`src/lib/tradeFinisher.ts` engine, `src/components/TradeFinisher.tsx` UI,
`npm run test:trade-finisher`). Sleeper username → league → your team +
partner + the offer on the table; both rosters' needs are read in the
league's own lineup and scoring (best-lineup points per position vs the
league median, depth, age/value profile → inferred Win now / Balanced /
Rebuild), and the search walks every offer one or two edits away (add,
remove, swap on either side; players and owned rookie picks, traded picks
resolved from `traded_picks`, priced on the board's Early/Mid/Late rows by
projected draft slot) keeping only versions inside 12% of even and legal
for both lineups, ranked by your goal, their goal, needs and fairness.
"Open in calculator" drops an offer (picks as the board's pick rows) into
the two sides. Also: the prospect scores card on the player page, and
`loadConsensusProjections` now tolerates a dev server answering the absent
paid projections file with the SPA index (parse, not status, decides).

Previously (2026-09-11) — Week 1 weekly-projection validation
(`docs/weekly-projections-week1-validation.md`, rerunnable via
`scripts/validate-weekly-projections.py`). Matchup layer agrees with Sleeper
(r 0.72–0.86 for RB/WR/TE starters); the misses are upstream: roster status
is never read (Josh Jacobs on the exempt list and a dozen IR/PUP/practice-squad
players carry full strips), the pool's per-team cut uses a hand-retrained
depth-order file from Sep 7 (Cooper Rush / Deshaun Watson are the real week-1
QB1s; Deebo Samuel, Diggs, Vele, Boutte, Waller, Keenan Allen have no row),
1-game backups outrank starters on the raw weekly board, and
`weeks_played()` marks week 1 played after the first two games. Fix list in
the doc. Then the fixes: the weekly builder reads roster status (RET/CUT
dropped, RES/EXE/DEV/FA zeroed from the current week with `active=false`),
`weeks_played()` needs every game of a week final, the pool ranks each
team/position group by the newest nflverse depth chart with RET/CUT/EXE/DEV
barred and RES last, `backup=true` marks 1–3 game lines, roster overrides
expire 2026-09-01. Daily audit wired: `refresh-data.yml` writes
`weekly-projections-audit.{md,json}` every run and the daily report carries
the card (blocking buckets go red). Open: pool-level redistribution when a
starter is dropped (GB backfield went to Chris Brooks, not Lloyd), and the
weekly/K/DST/IDP MCP tools live only in `mcp/dist/server.mjs`, which is the
hand-maintained source of truth (per `src/mcp-server.ts`); edited directly
for 1.0.89 so week mode applies roster status like an injury designation,
sorts backups below starters, and defaults to `currentWeek`. Python 0.3.4
exposes the same fields.

Previously (2026-08-19) — Season-prep data audit. Refreshed the Sleeper ADP snapshot
(the FFC / KTC / FantasyCalc / Sleeper fetch workflows are all green and
had already run this morning), then closed the season-rollover gaps the
daily automation would have hit at kickoff: NGS split per season from
nflverse's all-seasons file (it was dumping a decade of rows into
`ngs_2025_*`, and Week 1 would have overwritten 2025 with 2026); 2025
added to advanced stats / FTN / play-by-play / participation, which all
stopped at 2024; `refresh-data.yml` now commits the in-season
injuries / snaps / player-stats snapshots the MCP, Python package and
local dev read; and ESPN restored as a live ADP source — its snapshot
used a view that omits ADP entirely, so all 937 skill players were being
dropped from the consensus blend. Details in HANDOFF.md.

Then, from a downstream MCP report of "projections not refreshed since
2026-04-12": `get_projections` was serving `redraft-projections.json`, a
static April spine that is an *input* to the daily pool builder, not its
output — so it disagreed with `get_weekly_projections` and the site by
several PPG (Gibbs 21.1 vs 25.9). All four projection surfaces
(`get_projections`, `export_excel`, `import_excel`'s diff, the waiver
board) now read one accessor over the daily-rebuilt season pool. MCP
1.0.64 published to npm; **1.0.65 (get_metadata projection-freshness
caveats; `games`/`projPts`/`min_games` on get_projections and `gp` on the
weekly ranking table, after a downstream report that one-game backups
outrank starters on ppg) is not yet published**. Also bumped the refresh
workflow's `static-data-v4` cache key: with a constant key actions/cache
never re-saves, so newly-added downloads would have been re-fetched every
run forever.

Previously (2026-07-28) — Visitor tracking: first-party, cookie-less pageview analytics
(new `workers/visit-tracker` Cloudflare Worker on Workers Analytics
Engine + a `sendBeacon` hook in the app; daily-rotating anonymous
visitor hash, DNT/GPC honored). `/stats` JSON + mini dashboard at
visit-tracker.dachhack.workers.dev; visit counts + top
pages/referrers/countries now lead the daily report email (no in-app
stats tab by design); deploy wired into
`deploy-workers.yml`. One-time setup: add repo secret
`CLOUDFLARE_ANALYTICS_API_TOKEN` (Account Analytics: Read) and dispatch
deploy-workers after merge.

Previously (2026-07-24) — First weekly-projections layer: new
`scripts/build-weekly-projections.py` splits the season pool across the
2026 schedule (opponent def-vs-pos multipliers from 2025 points allowed,
regressed 60% + home/away, normalized back to the season line) into
committed `weekly-projections-2026.json`, refreshed daily by
`refresh-data.yml`; new "Weekly Projections" tab (week/pos/scoring
filters, matchup badges, playoff-weeks outlook). Season projections
already auto-refresh daily. Piped weekly projections into the MCP
(`get_weekly_projections`) and the Python package
(`load_weekly_projections()`); shipped 1.0.62 to npm + 0.3.2 to PyPI +
promoted prod. Then app-team feedback round (MCP 1.0.63): injury-aware
weekly availability, as_of staleness metadata, gsis/sleeper ids on
projection rows, silent 300/200-row caps lifted to 1000 with explicit
truncation notes, sleeper-projections `fields` bug fixed, in-season
def-vs-pos blend wired in the builder. Deferred items (in-season base
re-fit, Vegas multipliers, uncertainty bands) logged in
docs/MCP_FEEDBACK_BACKLOG.md Round 22. Added K + team-DST weekly
projections (32 each: depth-chart PK1s, team context + same matchup
framework; defVsPos gains K/DST entries). 1.0.63 was published to npm; 1.0.64 (this session) is not.

## Current blockers

- None.

## Next 3 tasks

0. MCP **1.0.89** + Python **0.3.4** (roster-aware weekly feed: status /
   active / backup / currentWeek, backups sorted below starters) tagged for
   publish from `claude/weekly-projections-validation-9krs95`; confirm the
   publish-mcp / python-publish / MCP-registry runs went green. Dispatch
   **Refresh Clay** (`refresh-clay.yml`) to unfreeze the `consensus`
   preset, stuck at 2026-06-16; leave `CLAY_PROJECTIONS_B64` unset so that
   workflow stays its only writer.
1. Fix projection-pool depth-share artifacts: deep TEs inflated (Greg
   Dulcich, Colby Parkinson) and Brock Bowers' TE TD line cold vs market.
2. Recalibrate the SFB16 big-play estimators against published SFB
   projections — the 20+-yd-reception rate runs ~5–13% hot for elite
   high-YPR receivers (candidate: coefficient 0.022 → ~0.018).
3. Post-draft SFB16 recap: score all 12 rosters with the SFB model once
   the Sleeper draft completes (draft 1366445711050162176).
4. Weekly projections v2: (in-season re-projection DONE 2026-09-24)
   complete), Vegas totals/spreads as game-environment multipliers, and
   injury/depth-chart awareness.
