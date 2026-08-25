# Sleeper manager-engagement model

Predicts **manager behavior** — not player performance — from Sleeper's public
API: will this manager go dark mid-season, will they come back to this league
next year, and what kind of platform user are they.

Three targets, one shared feature substrate:

| # | Target | Kind | Backtestable today? |
|---|--------|------|---------------------|
| 1 | **Abandonment** — weeks until a manager stops transacting | survival (right-censored) | yes |
| 2 | **League exit** — does a manager return to this league next season | binary, per lineage | yes, once lineages resolve |
| 3 | **Engagement segments** — what kind of user this is | unsupervised, validated against #1 | yes |

## Why these three

Everything Sleeper exposes about a *manager* is behavioral: transaction logs
with timestamps, roster snapshots, league portfolios across seasons. There is
no demographic data and no engagement telemetry, so "engagement" has to be
reconstructed from what managers *did* and when. The useful part is that this
reconstruction is available retroactively for every past season — unlike the
market feeds (trending adds, ADP), which Sleeper serves live-only and which
this repo does not yet log. **These three targets need no new data collection
to start training.**

---

## Data foundation

### The transaction sweep (implemented)

`fetchUserTransactionActivity` in [`src/lib/sleeper.ts`](../src/lib/sleeper.ts)
sweeps `/league/<id>/transactions/<week>` for every league-season a manager
fielded and keeps **every** transaction:

| Sleeper type | What it tells us |
|---|---|
| `free_agent` | add/drop activity, the baseline engagement pulse |
| `waiver` | claims, plus `settings.waiver_bid` — the FAAB actually spent |
| `trade` | player/pick/FAAB movement and counterparties |
| `commissioner` | admin activity (commissioners are a distinct segment) |
| status `failed` | **kept on purpose** — a failed waiver claim is an *attempt*, i.e. engagement, even though nothing changed hands |

This replaced a sweep that made the same requests and discarded everything
that wasn't a completed trade. `fetchUserTradeActivity` is retained as a thin
wrapper over it so existing callers are unaffected. The extra signal costs
**zero additional API calls.**

Two FAAB fields are easy to confuse and mean different things:

- `settings.waiver_bid` — FAAB spent winning a waiver claim. This is the
  bidding-behavior signal.
- `waiver_budget[]` — FAAB moved between managers *inside a trade*. Not a bid.

### League lineages (implemented)

Sleeper mints a **new `league_id` every season** and links seasons through
`previous_league_id`. A naive set-diff of league ids across seasons therefore
reports 100% churn every year, which would make every retention label noise.

[`src/lib/leagueLineage.ts`](../src/lib/leagueLineage.ts) runs union-find over
observed `(league_id, previous_league_id)` pairs and collapses league-seasons
into **lineages** — one stable identity per league across its whole life.

Union-find rather than pointer-chasing, because two managers who joined the
same league in different years have different chain roots. Following pointers
from each manager's earliest league would give them different keys for the
same league; union-find merges any two chains that share a single league id,
so both land in the same component.

> ⚠️ **Lineage ids are canonical only within one observation window.** The
> representative is the earliest observed season's league id (lexicographic
> tie-break). A later crawl that reaches further back can pick a different
> representative for the same league. Persist the mapping; don't recompute it
> ad hoc and expect stability across runs.

### The crawler (implemented)

`npm run crawl:sleeper -- --seed=<leagueId>` walks the league graph and writes a
population the audit can consume.
Source: [`scripts/crawl-sleeper-population.ts`](../scripts/crawl-sleeper-population.ts).

**League-oriented, not user-oriented.** There is no user-enumeration endpoint,
so the population has to be snowballed — but the crawl unit is a league-season,
not a manager. One league-season costs ~21 requests (league + rosters + 18
transaction weeks + winners bracket) and yields labeled rows for **every**
manager in it: under 2 requests per manager-season. A user-first crawl
re-fetches the same league-weeks once per manager and costs hundreds of requests
per row — identical data, ~100× the budget.

**Two expansion mechanisms, priced very differently.**

| | Cost | Notes |
| --- | --- | --- |
| **Vertical** — follow `previous_league_id` back through a league's own history | one league-season per hop, no user lookups | Always on. Builds exactly the lineages the retention labels need. |
| **Horizontal** — sample managers and enumerate their other leagues | one request per (manager, season) | Sampled (`--expandPerLeague`, default 3). Expanding a 12-team league fully would cost 48 requests — more than the league itself. |

**All-or-nothing league-seasons.** A league-season whose transaction weeks are
only partly fetched looks exactly like a league where managers stopped
transacting — the precise pattern the abandonment label detects. So budget is
reserved for a whole league-season before it starts, and one that cannot be
completed is **dropped, never emitted partially**. When the budget runs out the
population is smaller, never corrupted.

A dropped league-season still contributes its `previous_league_id`: if the
league document was readable, the chain keeps walking. Letting one transient
error sever a lineage would silently cost every retention label behind it.

**Derived season horizon.** Trailing silence is measured against the last week
a season could plausibly have had activity. Assuming week 17 for an in-progress
season would credit every manager with weeks of silence and label whole leagues
abandoned, so the horizon is taken from the data: the latest week anything
happened anywhere in that season.

**Politeness and reproducibility.** Paced well under Sleeper's ~1000 req/min
guidance (`--rpm`, default 600), bounded concurrency, `Retry-After`-aware
backoff on 429, and a read-through disk cache so a re-run costs nothing. The
walk is deterministic — roster-order sampling, sorted output — so two runs of
the same crawl diff cleanly. `--plan` prints the cost estimate without making a
request.

**Portfolio coverage is reported, not assumed.** A league-oriented crawl finds
managers *inside* leagues it visited, so it sees only the slice of each
manager's portfolio that overlaps the crawl. Manager-season features are
unaffected — every emitted league-season is complete. Profile-level features
(league count, retention rate, historical abandonment rate) are **biased** for
managers whose portfolio was never enumerated. The crawler records which ones
those are, and the audit reports the share and warns.

```bash
npm run crawl:sleeper -- --plan --seed=<leagueId>          # cost estimate only
npm run crawl:sleeper -- --seed=<id>,<id> --maxRequests=20000
npm run crawl:sleeper -- --seedUser=<username>             # seed from a user's leagues
npm run report:engagement-audit -- --input=sleeper-population.json
```

The crawl takes its fetcher by injection, so
[`scripts/test-sleeper-crawler.ts`](../scripts/test-sleeper-crawler.ts) drives
the entire graph walk offline against a fabricated Sleeper — budget exhaustion,
orphan rosters, a league outside the season window, a failing endpoint — none of
which can be produced on demand against the live API.

Fetches must run in CI or on a developer machine: these endpoints 403 from the
dev sandbox (see the header of `scripts/fetch-sleeper-adp.py`).

### Privacy line

Sleeper is 🟡 in [`DATA_SOURCES.md`](../DATA_SOURCES.md) — query it, don't
rebundle it — and this analysis profiles **named real people**, which the
player-data fetchers do not.

- Commit **model weights, segment centroids, aggregate distributions.**
- Never commit **per-user behavioral rows or computed profiles.** Profiles are
  computed on demand and cached ephemerally.
- Manager ids in crawler output are **salted-hashed by default**
  (`--reveal-ids` opts out for debugging). The models need a stable grouping
  key, not an identity. Populations and the HTTP cache are gitignored.
- Present abandonment as **league health** ("this league has 3 at-risk managers
  to replace before next season"), not as a targeting tool for exploiting
  checked-out opponents. Same model, defensible framing.

---

## 1. Abandonment

**Framing: survival, not classification.** The label is *weeks until
disengagement*, right-censored for in-progress seasons. Classification would
force you to wait for season end before scoring anyone; survival scores a
manager at week 7 from partial information, which is when the answer is
actually useful.

Label, per manager-season: the last week with any transaction. Disengaged =
no activity through season end while the league was still live.

Features, roughly by expected strength:

| Feature | Why |
|---|---|
| **current zero-activity gap** (consecutive silent weeks) | the core hazard term |
| **injured/out starter left in lineup for k weeks** | the strongest behavioral tell — a checked-out manager doesn't patch injuries. Needs the nflverse injury join; hooked but not yet wired |
| **empty starter slots** (`starters` containing `"0"`) | free, already in the roster payload |
| **mathematical elimination**, points-for percentile | elimination is the dominant driver of mid-season quitting |
| **unspent FAAB late** (budget remaining at week 10+) | disengagement shows up as an unspent budget |
| **prior-season abandonment** in any lineage | best single predictor of repeat behavior |
| dynasty vs redraft, league size, lineage tenure | dynasty abandonment is more damaging and behaves differently |

Two constraints that must be built in, not patched later:

- **Format gating.** Best-ball leagues auto-start lineups and often have no
  waivers, so every lineup-derived signal is meaningless there — unmasked, the
  model reads "everyone in best-ball abandons." `isBestBall` gates these
  features rather than acting as a covariate.
- **Bye weeks** produce false positives on empty-slot and injured-starter
  signals; both need the schedule join before they're trustworthy.

Evaluation: concordance index, plus calibration of the k-week-ahead hazard.
Calibration matters more than discrimination for anything surfaced as a
percentage.

## 2. League exit

Two distinct targets that are often conflated:

- **(a) Portfolio expansion** — P(manager fields ≥1 more league next season).
  The platform-growth metric.
- **(b) Lineage exit** — P(manager does not return to *this* lineage next
  season). The one commissioners want.

For (b), beyond that manager's abandonment score and finish: **the
co-membership graph**. `/league/<id>/users` across lineages reveals recurring
co-managers, and managers churn when their social cluster leaves — usually a
stronger signal than their own record.

**Confound that must be handled explicitly:** "left the league" conflates
*quit*, *removed by the commissioner*, and *the league folded*. If a lineage
terminates and every member disappears together, that is a league death, not
an individual decision. It has to be a separate class or excluded outright, or
the model learns nothing about the choice being predicted.

## 3. Engagement segments

Axes are defined first, then clusters are fit — and **validated by whether they
predict held-out abandonment.** Segments that don't predict behavior are
decoration.

| Axis | Measure |
|---|---|
| volume | league-seasons fielded |
| intensity | transactions per league-week |
| persistence | max lineage tenure, season-over-season retention |
| mode | dynasty / redraft / best-ball share |
| attention shape | temporal concentration of transactions — draft-only vs. in-season grinder vs. deadline-only |
| sociality | trade rate, trade-partner diversity (HHI) |

Implemented in [`src/lib/engagement.ts`](../src/lib/engagement.ts):

- `managerSeasonEngagement()` — per-league-season features from the sweep.
- `engagementProfile()` — the per-manager axis vector.
- `fitSegments()` / `assignSegment()` — k-means over a population, for when the
  crawl exists.
- `coldStartSegment()` — deterministic threshold classifier for a single
  manager with no population, so the feature works on day one.

**Shrinkage is mandatory.** A manager with a handful of transactions has no
personal estimate; evidence volume drives a confidence score and thin profiles
resolve to `Unclassified` rather than a confident wrong label.

Hypothesized segments (to be confirmed against fitted centroids): Commissioner
/ Superuser, Grinder, Draft-Day Enthusiast, Dynasty Lifer, Best-Ball Volume
Player, Casual One-Leaguer, Ghost. The Draft-Day Enthusiast is the interesting
one — high apparent engagement, poor retention.

---

## Verification

`npm run test:engagement` (`scripts/test-engagement-features.ts`) covers the
feature construction with synthetic fixtures — 65 assertions over lineage
merging across managers who joined in different years, absent-prior-league
markers, retention censoring and gap years, failed-claim accounting, the
`waiver_bid`/`waiver_budget` split, best-ball masking, empty-slot detection,
HHI, per-league-week intensity normalization, evidence shrinkage, and k-means
determinism.

Synthetic rather than live on purpose: these endpoints 403 from the dev sandbox,
and the edge cases above are hard to find on demand in real data.

---

## Reporting suite

Model reporting is worthless if the inputs are already wrong, so the suite
starts on the input side. `npm run report:engagement-audit` produces a
completeness and feature audit — versioned JSON plus markdown — and **exits
non-zero on a blocking defect**, so a bad population cannot quietly become a
training run.

`src/lib/featureAudit.ts` holds the audit; `src/lib/evalMetrics.ts` holds the
metric primitives (AUC with tie handling, Brier, log loss, quantile reliability
bins with ECE, calibration slope, Harrell's C, PSI, deterministic grouped
k-fold, IRLS logistic).

### The four failure modes it exists to catch

**1. Silent truncation.** The transaction sweep is capped at 700 league-weeks.
When the cap bites, the *oldest* seasons come back with no transactions —
indistinguishable from a manager who did nothing. Every engagement feature then
reads "inactive" for those rows, which is precisely the pattern the abandonment
label looks for. Nothing in the data announces this; only the `capped` flag
does. Widespread truncation blocks; isolated truncation warns.

**2. Target leakage.** `trailingSilentWeeks`, `lastActiveWeek` and
`activeWeekCount` are what the label is *computed from*. Handing any of them to
a model produces near-perfect scores that mean nothing — the audit measures
their signal (AUC ≈ 1.0) and reports it as the tell, not the prize.

**3. Prediction-time leakage.** `wins`, `losses`, `regSeasonRank`, `pointsFor`
and `champion` are known only at season end, so they cannot score a manager at
week 7. This is the mistake that would make the abandonment model look
excellent and be useless in the app.

**4. Broken masking.** Best-ball rows must carry null lineup features. If the
mask breaks, "everyone in best-ball abandoned" gets learned as signal.

### Feature eligibility is derived, not remembered

Every feature declares a `kind`, and eligibility follows from it — so a new
feature cannot be quietly used in the wrong place because a reviewer forgot
which columns are safe.

| Kind | Eligibility | Meaning |
| --- | --- | --- |
| `static` | ✅ eligible | fixed for the season; known at prediction time |
| `time-varying` | ⚠️ conditional | safe **only** recomputed as-of the scored week; the season total is not |
| `season-final` | ⛔ ineligible | not knowable until the season ends |
| `label-derived` | ⛔ ineligible | the label is computed from it |

Each feature also declares its hypothesised risk direction. The audit compares
that to the measured association and flags disagreement — a flipped sign is a
bug signal, not a finding.

### What else it reports

- **Completeness**: rows by season and format, distinct lineages, zero-activity
  rows split into *unlaunched league* (expected) vs *live league* (suspicious),
  rows with no roster id, transactions with no timestamp, empty-slot coverage,
  retention censoring share, lineage season gaps, required-field violations.
- **Per feature**: coverage, distribution, degeneracy (constant or one value
  covering >98% of rows), single-feature signal AUC, direction check, and
  season-over-season stability.
- **Collinearity**: pairs at |r| ≥ 0.9 among model-usable features.
- **Invariants**: eight structural checks; any violation blocks.

Two calibration choices worth knowing, because both were bugs first:

- **PSI bins are Laplace-smoothed.** Many of these features are low-cardinality
  integers, so a legitimately empty bin against an epsilon floor produced a PSI
  of ~25 — catastrophic-looking drift that was really one sparse bucket.
- **Stability is leave-one-season-out**, not season-vs-pooled. A pooled
  reference contains the season under test, which shrinks the apparent drift of
  the largest seasons and hides real shifts. Seasons below 30 usable rows report
  `n/a` rather than a guess.

### Privacy

The report contains aggregates only — counts, distributions, correlations — and
a test asserts no manager or league id appears anywhere in it, so it is safe to
upload as a CI artifact. The **input** is not: crawled populations are
gitignored, along with generated reports.

### Running it

```bash
npm run test:engagement:mlops                  # known-answer tests (hermetic)
npm run report:engagement-audit -- --demo      # render on synthetic data
npm run report:engagement-audit -- --input=<population.json>
```

`--demo` fabricates a deliberately imperfect population (best-ball leagues, a
capped sweep, absent starters, an unlaunched league) so the report exercises
every check instead of printing a clean sheet that proves nothing. Its numbers
describe fabricated data and the report says so at the top.

CI is `.github/workflows/engagement-audit.yml`: the hermetic tests gate every
change to the pipeline; the report job is `workflow_dispatch` because a real
report needs a crawled population, and Sleeper's endpoints only work from
runners.

---

## First real crawl — what it changed

A crawl seeded from one live Sleeper portfolio (320 league-seasons, 1,723
managers, 8,578 requests, nothing dropped or skipped) produced a label at 27.6%
positive over 1,491 scorable rows. Four problems surfaced that synthetic data
could not have shown, all now fixed and covered by tests.

**The leakage guard earned its place immediately.** `losses` (AUC 0.696) and
`regSeasonRank` were the strongest signals in the whole feature set, and both
are season-final — unusable to score a manager at week 7. `trailingSilentWeeks`
scored exactly 1.000, being what the label is computed from. Built naively, this
model would look good and be worthless.

**Vertical expansion had to outrank horizontal.** The first run queued 45,629
leagues while crawling 200, and only 12 of 195 lineages spanned more than one
season — a single FIFO queue starves the vertical hops that produce every
retention label. Splitting the frontier took multi-season lineages from 12/195
to 61/306 and nearly doubled scorable rows.

**Zero-activity rows needed classifying, not counting.** 994 rows were flagged
as "live league, no activity"; 955 were best ball, which has no waivers and no
lineup to set. Stripping the expected explanations (unlaunched, best ball, season
in progress) leaves 29 rows — a believable count of genuinely dead teams.

**A hypothesis was wrong, and a warning was noise.** `longestSilentRun` measured
0.424 against a "higher-risk" expectation. It counts gaps *between* the first
and last active week, so a manager who quits in week 3 has almost no room for
internal gaps while one active all season has sixteen weeks of opportunity: as a
season summary it is span-confounded, and the real hazard term is
weeks-since-last-transaction as of the scored week. The hypothesis is corrected
in the spec with that reasoning. Separately, a direction now requires a minimum
effect size — the same feature had been flagged at 0.479 on a smaller sample,
which is a two-point deviation and pure noise.

**Composition shift was masquerading as feature drift.** 13 of 15 usable
features were flagged as drifting. The cause was the sample: best-ball share
swung from 27% to 82% across seasons and the current season had a one-week
horizon. Stability now measures on scorable rows only, skips in-progress
seasons, and when a composition shift is already detected the per-feature
warnings collapse into one attributed line. Warning count went 18 → 5, all
distinct.

### Known limits of this population

- **Best ball dominates.** 57% of rows are best ball and excluded from the
  abandonment label, so the trainable population is far smaller than the row
  count suggests.
- **Portfolio coverage is 18% known, 7% crawled.** Profile-level features
  (league count, retention rate, historical abandonment rate) are biased for the
  rest and should be restricted to managers with a known portfolio.
- **One seed portfolio.** Every manager reached is a league-mate or a
  league-mate's league-mate, so this is not a sample of Sleeper — it is a
  neighbourhood. Treat cross-population claims with suspicion until the crawl is
  seeded more widely.

## Status

| Step | State |
|---|---|
| Full transaction sweep | **done** |
| League lineage resolver | **done** |
| Engagement features, profile, segments | **done** (cold-start thresholds; centroids await a crawl) |
| Completeness + feature audit reporting | **done** |
| Metric primitives (AUC, Brier, calibration, C, PSI, grouped CV, IRLS logistic) | **done** |
| Abandonment survival model | not started — features and metrics are in place |
| League-exit model | not started — needs a crawl for lineage-level labels |
| Model-eval reporting (calibration curves, skill vs baselines, slices) | not started — blocked on the model |
| League-oriented crawler | **done** — needs seed league ids and a CI run to produce real numbers |
| Surfaces (Snooper panel, league-health map, MCP tool) | not started |

Deliberately deferred: the injured-starter-hold feature and bye-week masking
both need the schedule/injury join, and shipping them half-done would put a
misleading signal into the abandonment model.
