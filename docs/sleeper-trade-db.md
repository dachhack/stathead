# Sleeper trade database

A growing database of real, completed fantasy trades from public Sleeper
leagues, with the league context needed to value them, plus every FAAB waiver
bid (won and lost). It is an **input** for StatHead's own numbers (for example,
trade-implied dynasty values and pick values). Per-trade or per-manager rows are
never shown on the site, in MCP output or in exports.

## Pieces

| | |
|---|---|
| `scripts/crawl-sleeper-trades.ts` | the crawler (`npm run crawl:trades`) |
| `scripts/test-sleeper-trade-crawler.ts` | offline tests (`npm run test:trade-crawler`) |
| `scripts/build-sleeper-trade-db.py` | merges the shards into `sleeper-trades.sqlite` |
| `.github/workflows/sleeper-trade-crawl.yml` | daily ~5.5 h crawl in CI |
| `scripts/sleeper-trade-db-pull.sh` | download, decrypt and build locally |

## What a crawl collects

Per **league-season** (`leagues` / `rosters` / `drafts` / `draft_picks`):
- format: dynasty / keeper / redraft, teams, QB and superflex slots, starters,
  bench, taxi, IR, IDP, PPR, TE premium, pass-TD points, carries, best ball,
  FAAB budget, trade deadline, playoff teams and start week, rookie-draft rounds,
  pick trading; plus the full Sleeper `settings`, `scoring_settings` and roster
  slots as JSON, so nothing is lost to the summary;
- every roster: record, points for / against, max points, final rank, champion,
  FAAB used, players, starters, taxi, IR, keepers;
- weekly matchups up to the last in-season trade;
- every draft (startup, rookie, redraft, auction) with its slot order and every
  selection (and auction price);
- the lineage pointer to the league's previous season.

Per **trade** (`trades` / `trade_sides` / `trade_assets`):
- each side's players, draft picks (season, round, original owner) and FAAB,
  in and out; players cut or added in the same transaction;
- each team's record, points and rank at the time of the trade (in season),
  its final record and rank, and last season's rank and championship;
- every traded pick resolved through the lineage to the draft it was used in:
  overall pick number, slot and the player selected (`pick_status`:
  `resolved`; `slotted` when the order is set but the pick is not made yet;
  `no_draft` / `order_not_set` / `not_crawled` otherwise);
- Sleeper's raw encoding (`adds`, `drops`, `draft_picks`, `waiver_budget`).

Per **waiver claim** (`waivers`): player, bid, won or lost, league FAAB budget,
teams, type and superflex. `--allMoves` adds free-agent and commissioner moves.

## How the crawl works

Sleeper has no league search, so discovery snowballs from seeds: a league's
managers (one sampled per league, while fewer than 20,000 leagues are queued)
→ their other leagues this season and last, and each league → its earlier
seasons. Order: a league's earlier seasons first (complete lineages), then
seeds, then dynasty, keeper and redraft leagues, newest season first. Leagues
with trading disabled are never fetched.

Cost is about 20 requests per league-season. A first live test (Oct 2026,
seeded from one account, 4 minutes) crawled 153 dynasty-heavy league-seasons
from 2019 to 2026: 3,090 trades and 23,584 waiver claims, about 20 trades per
league-season, with 79% of traded picks resolved to the player taken. At 800
requests/min (under Sleeper's ~1,000/min guidance) a 5.5 h run should add
roughly 200k trades; expect fewer per league once the crawl reaches redraft.

The current season is crawled through the current week. **New trades** come
from re-reading this season's leagues, not from crawling everything again:
past seasons never change.

- **Daily:** the workflow passes `--refreshCurrent=auto`. The first run 20 or
  more hours after the last refresh re-queues every current-season league
  that isn't complete, ahead of discovery.
- **A re-read is a delta.** It reads transactions from the week last read
  (trades can land later in that same week) through the current one, plus
  week 1 in the offseason, where Sleeper files offseason moves. It also reads
  rosters, matchups only for leagues with new trades, and drafts only in the
  offseason. That is about 3 requests a league, against about 10 for a full
  crawl.
- **The builder** keeps the newest league row and dedupes trades and waivers
  by id. A refresh row (`delta`) keeps the earlier row's transaction counts,
  and its drafts stay as stored.
- **Metrics:** `refreshed` and `refreshPending` in the run metrics. The
  workflow input `refresh_current` forces a refresh (`true`) or skips it
  (`false`).
- **Fixed with this change (2026-10-22):** the old Tuesday-only refresh
  re-queued only leagues read at an earlier week, re-read every week from
  week 1, and in the offseason (current week counted as 18) re-queued
  nothing, so offseason trades were never refreshed.

Each run appends gzipped JSONL shards and saves `state.json.gz` (frontier,
visited leagues, managers already expanded), so the next run continues where
this one stopped. A league that fails midway is not marked visited and nothing
from it is written, so it is retried cleanly.

## Privacy

Sleeper data is public, but these are real people.
- League, user, draft and transaction ids are salted SHA-256 hashes
  (`SLEEPER_CRAWL_SALT`). Keep the salt constant: the crawler refuses a state
  built with a different one, because ids would stop joining across runs.
- League names, team names, display names, avatars and chat text are never
  stored.
- Nothing is committed (`data-private/` is gitignored). In CI the state and
  each run's shards are AES-256 encrypted (`SLEEPER_TRADES_KEY`) and kept as
  assets on the `sleeper-trade-db` release, which is public, hence the
  encryption. The state holds raw league and user ids (it has to, to continue
  the crawl), so it is encrypted too.

## Setup

1. Repo secrets: `SLEEPER_CRAWL_SALT` and `SLEEPER_TRADES_KEY` (long random
   strings; store them somewhere safe, since losing the key loses the database
   and losing the salt breaks id joins). `EXPERT_USERNAMES`, if set, adds seeds.
2. Run **Sleeper trade crawl** from the Actions tab, or wait for the daily run.
3. Locally: `SLEEPER_TRADES_KEY=... bash scripts/sleeper-trade-db-pull.sh`,
   then query `data-private/sleeper-trades/sleeper-trades.sqlite`.

Example: what a 2027 first costs in superflex dynasty, by month:

```sql
SELECT strftime('%Y-%m', t.created / 1000, 'unixepoch') AS month, COUNT(*) AS n
FROM trade_assets a JOIN trades t ON t.id = a.trade_id
WHERE a.kind = 'pick' AND a.pick_season = 2027 AND a.pick_round = 1
  AND t.type = 'dynasty' AND t.sf = 1 AND t.n_sides = 2
GROUP BY month ORDER BY month;
```

## Yahoo

`scripts/crawl-yahoo-trades.py` (tests: `python3 scripts/test-yahoo-trade-crawler.py`)
adds Yahoo trades in the same row shapes, built with the same
`build-sleeper-trade-db.py`. The daily `yahoo-trade-crawl.yml` keeps its data on
its own encrypted release, `yahoo-trade-db`; pull it with
`TAG=yahoo-trade-db DIR=data-private/yahoo-trades bash scripts/sleeper-trade-db-pull.sh`.

- **Reach.** The app key alone (two-legged OAuth 1.0a) reads publicly viewable
  leagues. The Oct 2026 probe (`scripts/probe-yahoo-fantasy.py`, 60 ids per
  season) found 13–20% of league ids readable in 2024–2026; the rest were
  private ("must be logged in") or errored. League ids are integers per season,
  so the crawl walks them from a saved cursor (25 per batch request when Yahoo
  allows it) and follows each league's `renew` link into earlier seasons.
- **League type is inferred.** Yahoo has no dynasty setting. `dynasty` = renewed
  from last season with a draft of at most 40% of roster spots, or keepers
  filling most rosters; `keeper` = any keepers; else `redraft`. The evidence is
  kept per league (`typeEvidence` in the shards) and the raw settings are
  stored, so the rule can be refined without re-crawling.
- **Players** map to Sleeper ids through `public/data/player-crosswalk.json`;
  unmapped ones keep a `y:<yahoo id>` id and are named in the `players` table.
- **Yield** (first clean run, Oct 2026, 30 min, one worker): 425 ids, 46%
  readable, 81 empty leagues skipped, 115 leagues (all redraft), 190 trades
  across 2022–2026, 1,098 FAAB adds, 56 req/min with no throttling. Requests
  are latency-bound, so two workers share a 75/min cap (`--workers`,
  `--rpm`): 144/min drew 999 'request denied' throttles within 10 minutes; transaction lists of exactly 25/50/100 are paged with `;start=`.
- **Gaps against Sleeper.** Traded picks name a round and original team but no
  season (`pick_status = 'yahoo_no_season'`); FAAB shows winning bids only;
  records at trade time are not fetched yet (final standings are).
- **Privacy.** League keys (also inside team and transaction keys), team keys
  and manager guids are salted hashes; league, team and manager names are
  dropped, including from the raw transaction kept with each trade.

## Monitoring

After every run, each crawl workflow publishes `metrics.json` on its release
(`scripts/publish-crawl-metrics.py`). Unlike the crawl data, it isn't
encrypted: it holds only aggregate counts per run. That covers league-seasons,
trades, waiver claims, the request rate, why the run stopped, the queue size,
totals so far, the trade mix by format and the share of picks resolved. There
are no ids and no names. The daily report (`scripts/daily-report.py`, "Trade
crawls" card) reads it with the run history. It warns when a Sleeper run fails
or none has finished in 8 hours.

## Analysis (weekly)

`.github/workflows/trade-db-analysis.yml` runs Wednesdays at 09:17 UTC, and on
demand. It downloads and decrypts every run of both crawls on the runner and
builds each database with `--lite`. A lite build skips waivers, raw JSON,
league settings and roster player lists, because a full build of every run
would not fit in a runner's memory. Two jobs run on that build:

- **Audit** (`scripts/audit-trade-db.py`) writes `audit.json`, counts only,
  with any cell under 10 suppressed. The file goes on each crawl's release
  next to `metrics.json` and in the job summary. It covers:
  - formats and seasons;
  - league settings: teams, TE premium, PPR, best ball, IDP, pick trading;
  - trades per league-season;
  - timing: week and month;
  - trade shapes: what each side gets;
  - pick resolution by how far ahead the pick was;
  - quality screens: multi-team, 10+ assets, gifts, one manager on both sides,
    orphan sides, repeat pairs, hyperactive leagues, trades after the
    deadline;
  - the format mix of the sampled managers' whole league lists (the
    population, since the crawl reaches dynasty first);
  - waiver bids as a share of the FAAB budget;
  - player activity over the last 52 weeks: players ranked by trades, and per
    rank tier (1–50, 51–200, 201–500, 501+) trades per week and the weeks the
    median player needs to gather 20 and 50 trades. This is how long a window
    a point-in-time player value has to lean on;
  - crawl lag: the hours from a trade being made to the run that first saw
    it. This is the floor on how current a value can be.
- **Pick values** (`scripts/fit-pick-values.py`) writes
  `public/data/pick-values.json`. It fits values to every two-team trade of
  picks only (no players, no FAAB), for dynasty and keeper leagues, separately
  for superflex and 1QB.
  - **Pick classes:** round (1–4, 5+), seasons ahead (0 = the next rookie draft,
    up to 3+), and E/M/L tier from the original owner's standing at the trade.
    The standing is the record in season, or last season's finish before any
    games.
  - **Startup picks are left out.** A trade is dropped if any of its picks
    resolved to a draft of more than 6 rounds, comes from round 7 or later, or
    is for the trade's own season in a league-season with such a draft. A
    startup 1.01 is a top-ten player, not a rookie pick. On the first full run
    (2026-10-20), leaving them in priced a superflex 1st one year out at 21.
  - **The fit:** each trade is read as even. Values are fitted with a soft-L1
    loss on log(side A / side B). Each league-season counts as at most 5
    trades, and thin tiers are pulled toward their round's mean.
  - **Scale:** 100 = a mid first in the next draft. The scale is additive: two
    50s trade for one 100. A consolidation premium (v^k) can't be identified
    from even swaps alone.
  - **Outputs:** global values with 90% bootstrap intervals over leagues;
    values per calendar year; and "current" values from the last 120 days. The
    yearly and current fits are pooled toward the global fit. A held-out check
    compares fit error with counting picks.
  - **`realized`:** what each rookie-draft round and slot tier returned: the
    drafted player's best PPR per game in years 1–3, and the share with a
    12+ season. It uses classes with three finished seasons, matched by
    Sleeper id through the crosswalk.

On synthetic trades drawn from known values
(`scripts/test-trade-analysis.py`, `npm run test:trade-analysis`), the fit
recovers well-populated classes within 16%. Early, mid and late firsts came
out 132 / 100 / 82 against true values of 130 / 100 / 80. Cheap picks (late
3rds and beyond) run about 10% high, because the ridge pulls tiers together.

### Weekly vs monthly runs

The workflow is incremental on most Wednesdays. The first Wednesday of a month,
or a manual run with `full=true`, is a full run. The first all-history runs
took about 55 minutes, mostly 12 full player fits.

- **Smoothing (`LAMBDA`):** a full run re-picks it on held-out leagues. A
  weekly run reuses the last choice; the four candidates scored within 0.003 of
  each other. Skipping the smoothed fits removes most of the player step.
- **As-of pass:** a weekly run resumes from `asof-state.npz` on the
  `sleeper-trade-db` release. That file holds week snapshots of StatHead
  values only, no trades. The run redoes the newest 4 weeks, for trades that
  arrive late, and then the weeks since. Past values don't change; the test
  shows a resumed pass matching a from-scratch one. Trades the crawl backfills
  into older weeks are taken in by the monthly full pass.
- **Waiver audit:** a weekly run carries the last full audit's waiver section
  (`carriedFrom`), since reading 18M claims was most of the audit's time.
- **Superflex and 1QB** are fitted in parallel.
- **Trimmed date range (player fit only).** The player fit loads only the
  trades the as-of pass can reach: about 3.5 seasons back (156 weeks of
  history, a 26-week burn-in and the 12-week window). The query filters them,
  and each league-season's earlier trade count is seeded so the weights don't
  change. A test shows trimming leaves every published value exactly
  unchanged. `tradesAll` counts trades in that span. The pick fit keeps every
  year.
- **`LAMBDA` tuning** uses the last two seasons (104 weeks), not eight years.
- **The build** parses shards with `orjson`, skips SQLite journaling, and
  resolves picks with one query per draft instead of one per pick (3.7M
  queries before).

### Player values (v1)

`scripts/fit-player-values.py` runs in the same weekly workflow. It writes
`public/data/player-trade-values.json`, which holds current values per format,
and `player-trade-values-history.json`, which holds weekly values for the last
three seasons for players in 100+ trades. Both are StatHead model output only.

- **Data:** every completed two-team trade in a dynasty or keeper league with
  no FAAB, superflex and 1QB fitted separately. Assets are players and rookie
  picks; pick classes and the startup filter are shared with the pick fit
  (`scripts/trade_values_common.py`). Players in fewer than 20 trades are
  fitted but not published.
- **Model:** each trade is read as even, and the fit balances the sum of each
  side's values. Each player and each pick class has one value per week:
  `phi[w]`, with value = `exp(phi)`. Weekly values follow a random walk,
  penalised by `LAMBDA * (phi[w] - phi[w-1])^2`. A busy player's value follows
  the last few days; a thin one leans on months either side. The loss is
  soft-L1 on log(side A / side B). Within a league-season, each trade past
  the 30th weighs 30/n. `LAMBDA` is chosen from 1, 3, 10 and 30 on held-out leagues.
- **IDP players** are named and positioned from the crosswalk, since Sleeper's
  slim player list covers offense only. They are flagged `idp`: their values
  come from IDP leagues only, so a general ranking should leave them out.
- **Scale:** 100 = a mid 1st in the next rookie draft, the same week. The pick
  is the unit, so seasonal rookie-pick hype moves every player a little.
  Values are additive.
- **Seasons ahead** for picks is counted from each league's own next rookie
  draft (`DraftCalendar`), with a calendar fallback.
  - A pick for this year's draft traded after that draft started counts as the
    next draft: slow drafts run for weeks, and picks change hands during them.
  - Next year's picks count as a season out until 30 days after this year's
    draft starts.
  - The first run with the calendar (2026-10-20) missed the in-draft case. It
    dropped 227k trades as holding used picks, and pick-only trades fell from
    123k to 27k. The calendar-only rule
  put a June trade made after a May draft a season too far ahead.
- **As-of values (2026-10-20).** Every published value, current or past, uses
  only trades up to the end of its week, so the history can be backtested.
  - **Forward pass:** each week, refit the last 12 weeks of trades. Each
    asset's value at the window's start is tied to its own as-of value from
    then, which carries older history forward.
  - **Every player is fitted.** The 20-trade minimum only decides what is
    published. Dropping rare players' trades let later trades change who was
    fitted at all.
  - **League-season weights are causal:** the n-th trade past 30 weighs 30/n.
  - **Tested:** a crawl cut off after week 20 gives the same values through
    week 20 (0.00% median change), and a one-week jump is not anticipated.
  - **Still uses all data:** the smoothed all-history fit only picks `LAMBDA`
    on held-out leagues, a single hyperparameter.
  - **Check:** each week's trades are priced with the previous week's values,
    out of sample (`nextWeek` in the output).
  - **Later steps:** jumps on injury and transaction dates, team count and
    contender context, and redraft values.
- **League scoring (2026-10-21).** About 71% of trades come from leagues with a
  TE premium (36% at 0.5 a catch, 24% at 1.0 or more), so pooling them priced
  TEs at a premium-league mix. Now, in a trade, a TE in a TE-premium league is
  worth his value x a premium factor (one factor under 0.75 a catch, one for
  0.75+), and a QB in a league scoring passing TDs at 6 is worth his value x a
  6-point factor. The factors are assets of their own: a weekly random walk,
  as of, shared by every TE or QB in the format.
  - Published `value` is for no TE premium and 4-point passing TDs, the same
    basis as the StatHead blend. TEs and QBs carry `scoring` (their value in
    the other scorings), and each format carries `scoring` (the factors, a
    year ago, and the trades behind them). The page has a scoring picker.
  - The all-history fits that pick `LAMBDA` leave the factors out.
  - A saved as-of state from before the factors is not resumed: the first run
    after this change runs the as-of pass in full.
  - The audit's `settings.pass_td` and `settings.scoringByFormat` show the
    passing-TD and TE-premium mix by format.
  - Synthetic test: planted factors x1.15 / x1.3 / x1.2 come back as x1.14 /
    x1.28 / x1.18.
- **Outlier trades (2026-10-21).** Each trade is priced with the previous
  week's as-of values (out of sample, scoring factors on). An outlier gives
  one side 2.5x+ the other (extreme: 4x+). Screens known when the trade was
  made: an orphan side, the same two managers' 6th+ trade that league-season,
  after the league's deadline, 10+ assets.
  - **Damping:** an outlier that is also screened orphan or repeat pair (the
    dump pattern) weighs 0.1 in the as-of pass, decided when its week is
    reached from the values before it. Other outliers count in full: many
    are news. `--dump-weight=1` turns it off. LAMBDA tuning damps the same
    trades (from a first smooth fit) and leaves them out of its score.
  - **Output** (counts and shares only): `outliers` per format: overall and
    last-4-week shares, shares by screen and unscreened, `downWeighted`, a
    52-week weekly share, and on full runs `sensitivity`: the last 13 weeks
    refitted without every screened trade, and without every outlier, with
    the median / 90th percentile / top-100 change in published values.
  - **Synthetic test:** 4% extra dumps (an orphan side giving a player away
    for a fifth of his value). Undamped, the median error went from 2.5% to
    27% (relative error 6.1%). Damped, 98% of dumps are flagged against 0.5%
    of clean trades, and the relative error is 3.2%. A +15% shift of every
    player against the mid 1st remains. It comes from the dumps in the first
    two or three weeks, before there are values to price them with. The
    as-of pass does not undo a shift of every player at once, because each
    player's anchor resists it. A real pass runs 26 burn-in weeks before
    anything is published, with far more pick trades, but this is the place
    to look if values ever drift against the pick scale.
- **Gradient fix (2026-10-21).** The soft-L1 loss is 2 DELTA^2 (sqrt(1 +
  (r / DELTA)^2) - 1), whose derivative is 2r / sqrt(...); the code used half
  that. L-BFGS then stopped short of the optimum in the player fit, the as-of
  pass and the pick fit. All three use the right gradient now, so values move
  a little on the next run.

**Meta stats per player** (all from as-of values, so no look-ahead; field
definitions are in the output's `fields`):

- **Trend:** `change1w` / `change4w` / `change12w`.
- **Speed:** `velocity` is the slope of log value over 4 weeks, in % per week.
  `acceleration` is that velocity minus the velocity over the 4 weeks before.
- **Variability:** `volatility` is the standard deviation of weekly changes
  over 12 weeks.
- **`trend`:** rising, falling or flat. A trend needs a 4-week move past twice
  four weeks of ordinary noise.
- **Trade disagreement:** `dispersion` is the robust spread of the value each
  of the last 4 weeks' trades implies for the player.
- **Range:** `ciLow` / `ciHigh` is a 90% range from dispersion over the trade
  count, plus volatility.
- **52-week range:** `high52w` / `low52w` / `fromHigh`.
- **Standing:** `rank` / `posRank`, over offense only.
- **Liquidity:** `trades1w` / `trades4w`.

The synthetic test plants players rising or falling 5% a week:

- **Velocity** finds 16 of 20.
- **The `trend` label** catches 7 to 10 of 20 across synthetic draws, with a
  0-4% false-label rate on random-walk players. A looser threshold (1.5) caught one more and quadrupled
  the false labels.
- **The 90% ranges** cover the true value 91% of the time. From dispersion
  alone they covered 44%.

Synthetic test (`scripts/test-player-values.py`): 300 drifting players over
40 weeks, 12k trades. The fit tracked the truth at log correlation 0.994 with
a 3.7% median error on current values, and put a mid 2nd at 41 against a true
40. On held-out leagues the weekly fit beat a single all-time value per player,
0.029 vs 0.066 median |log ratio|. A player who doubles in one week is caught
but smoothed: ×1.46 across 12 weeks against a true ×1.70. That is what the
jump-on-events step will fix.

### Forecasts and the Trade Values page

`scripts/train_trade_value_forecast.py` runs after the player fit in the same
weekly workflow. It forecasts each player's value 1, 3, 6 and 12 months out
and writes `public/data/trade-value-forecasts.json`.

The approach is the one in `scripts/train_ktc_timeseries.py`: LightGBM on
H-week log returns, with median and 10% / 90% quantile models. It is trained
on StatHead's own as-of values, which have no look-ahead and cover three
seasons. The KTC history held 179 days, so its horizons stopped at 120 days.

Features (all known at the time):

- **Momentum:** returns, volatility, distance from the 52-week high, position
  rank percentile and its 4-week change.
- **Calendar:** week of the year.
- **Player:** age (crosswalk birth date), years in the league and draft
  round / pick (nflverse draft picks).
- **Production:** PPR per game this season and over the last 4 games, last
  season's PPG and games (nflverse weekly stats, counting only weeks already
  over).

The models are heavily regularised. Weekly samples of a player overlap, so the
effective sample is much smaller than the row count, and the 1-year model is
the smallest.

Checked walk-forward against "no change", on 2026-10-21, 4 cutoffs, testing
13 weeks after each:

| | 1 month | 3 months | 6 months | 1 year |
|---|---|---|---|---|
| Superflex: error lower by | 3.1% | 3.6% | 7.2% | 3.5% |
| Superflex: direction right on 10%+ moves | 67% | 68% | 72% | 65% |
| 1QB: error lower by | 4.1% | 1.6% | 1.5% | 1.0% |
| 10-90% range covered | 75-83% | | | |

Short horizons lean on the time of year. A year out leans on value, draft
capital and age, and catches aging declines (Kelce, Adams, Henry, Rodgers
forecast down 18-24%).

The **Trade Values** tab (`src/components/TradeValuesView.tsx`, Dynasty menu)
shows, for every offensive player:

- the value, its 90% range and rank;
- 4-week change, velocity, trend, volatility and dispersion;
- trades in the last 4 weeks and the distance from the 52-week high;
- the four forecasts.

A row expands to a chart of the weekly history and the forecast points with
their 80% ranges. Below the player table are the rookie-pick values and a
method / accuracy note. Only StatHead output is shown.
