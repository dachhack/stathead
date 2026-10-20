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

The current season is crawled through the current week. On Tuesdays (or with
`--refreshCurrent`) leagues crawled at an earlier week are re-crawled, and the
builder keeps the newest copy of each league-season and each trade.

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
