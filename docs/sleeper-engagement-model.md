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

### Two feature levels, two different crawls

The pipeline builds features at **two levels**, and they have different data
requirements — a single crawl cannot serve both.

| Level | Unit | What it needs | Status |
| --- | --- | --- | --- |
| **Manager-season** | one team, one season | every transaction week of that league-season | league-oriented crawl, complete |
| **Manager** | a person across their portfolio | their whole league list, and ideally transactions for all of it | portfolio enumeration, partial by design |

A league-oriented crawl finds managers *inside* the leagues it visits, so it
sees a median of ~2% of any given manager's portfolio. Manager-season features
are unaffected — each crawled league-season is complete. Manager-level features
are not: league count, format mix, tenure and retention are all portfolio
quantities, and a 2% sample of them looks exactly like the real thing.

**The cheap half.** Three of the five behavioural axes need only the league
*list*, not the transactions: `/user/<id>/leagues/nfl/<season>` returns full
league objects, so format and `previous_league_id` come free with the
enumeration.

| Axis | Needs | Cost |
| --- | --- | --- |
| volume (league count, seasons active) | enumeration | ~1 request per manager-season |
| mode (dynasty / redraft / best-ball share) | enumeration | — |
| persistence (tenure, retention) | enumeration | — |
| intensity (transactions per league-week) | transaction sweeps | ~21 requests per league-season |
| sociality (trade rate, partner HHI) | transaction sweeps | — |

So the crawler runs an **enumeration pass** after the main crawl: for every
manager it discovered, it lists their leagues. That makes volume, mode and
persistence exact for roughly the cost of one more crawl, while intensity and
sociality stay sampled — permanently, because sweeping a median 141-league-season
portfolio would cost ~3,000 requests per manager.

Every profile therefore carries **provenance** per axis (`portfolio` = exact,
`crawled` = sampled) and the swept share of the portfolio. The audit reports
which, and warns when a population mixes the two — pooling exact and 2%-sampled
league counts is worse than having neither.

**One leakage rule specific to this level.** `historicalAbandonmentRate` is
derived from the abandonment label. Across prior seasons it is legitimate and
probably the strongest predictor available; computed including the season being
scored it is straight target leakage. `engagementProfile` takes an `asOfSeason`
that excludes that season and everything after it, and the audit marks the
feature `label-derived` so it can never be used unguarded.

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

---

## To-date feature recomputation

The audited manager-season features are season totals, and a season total of how
much someone transacted is entangled with when they stopped — which is what the
label reads. None of them can score a manager mid-season. Measured on the real
population, the leakage-free ceiling without this step was **AUC 0.522**: three
static league-context columns and nothing else.

[`src/lib/hazardFeatures.ts`](../src/lib/hazardFeatures.ts) expands each
manager-season into one row per week, with every feature built from weeks
**strictly before** the week being scored.

**Strictly before, not through.** The event at week w *is* "no activity from w
onward". Folding week w's own activity into its features hands the model the
answer. The prefix state is advanced only after a row is emitted, so the
guarantee is structural rather than a convention someone has to remember.

**The invariant is a test, not a comment.** For every row at week w,
`scripts/test-hazard-features.ts` deletes every event from week w onward,
rebuilds, and asserts the feature vector is byte-identical — and separately
asserts the features are not simply constant. Moving one line so the current
week is consumed before scoring fails the suite.

**Risk set.** Rows run `F+1 .. T` where F is the first active week. A manager
cannot stop before they have started, and week F+1 is the first week with any
history behind it. If `horizon - L >= minTrailing` they went dark: `T = L+1`,
the first week of the terminal silence, carrying `event = 1`. Otherwise `T =
horizon` and every row is censored. Internal gaps are not events — a manager who
goes quiet for six weeks and returns never stopped, and the gap becomes
`weeksSinceLastTxn`.

**Prior seasons** are strictly earlier, so a season never sees its own outcome.
A first observed season gets `null`, not `0` — no history is not a clean history
— paired with `priorSeasonsObserved` so the two are distinguishable.

### The feasibility artifact

Because the event week is `L+1`, every event row has `weeksSinceLastTxn == 0`.
Rows mid-gap can **never** be events: 7,928 of 17,621 on the real population.

A model scored over all rows gets that separation free and reports **0.873**;
within the feasible set it is **0.767**. Not leakage — no feature sees the
future — but not skill either. Every row carries a `feasible` flag and the
number to quote is the feasible-set one.

### What it unlocks

Manager-grouped 5-fold CV, logistic, 17,621 person-periods from 1,434
manager-seasons, weekly hazard 2.3%:

| Model | AUC (all rows) | Notes |
| --- | --- | --- |
| week only | 0.513 | bare baseline hazard |
| static league context | 0.522 | the ceiling before this work |
| weeks since last transaction | 0.690 | single feature |
| **full to-date set** | **0.873** | inflated by the artifact above |
| **full set, feasible rows only** | **0.767** | the honest number |

Calibration on the feasible set: slope 0.906, ECE 0.0075 — usable as a
percentage, which matters more than discrimination for anything shown in the UI.

### Choosing the target — and checking it is worth predicting

Two framings, both implemented (`HazardOptions.target`):

- **`silent-through-horizon`** (default) — "is there any activity from week w to
  the end of the season?" A *state*, askable at any week including mid-quiet-spell.
  Every row is feasible.
- **`stops-this-week`** — "does the terminal silence begin at week w?" An
  *event*, carrying the feasibility artifact above.

**A runway guard applies to both.** Scoring stops once fewer than `minTrailing`
weeks remain. With less runway than that, "gone" cannot be distinguished from an
ordinary quiet fortnight — and the tail of a season is dominated by managers who
are simply out of contention rather than disengaged.

That guard turns out to answer the obvious objection structurally. **Zero events
occur after week 13**: an event at L+1 needs `horizon - L >= 5`, so L ≤ 12. A
manager who checks out in week 14 having missed the playoffs is *censored*, never
labelled. The concern cannot enter the label.

**But is the label just "bad teams quit"?** Measured, not assumed:

| Final standing | Seasons | Went dark |
| --- | --- | --- |
| top third | 387 | 14.5% |
| middle third | 467 | 21.2% |
| bottom third | 580 | 44.3% |

A real 3× gradient. It does not explain the model, though:

| | AUC |
| --- | --- |
| final standing alone | 0.654 |
| to-date behaviour alone | **0.827** |
| both | 0.849 (+0.022) |

Behaviour beats standing by a wide margin, and standing adds almost nothing on
top. Within finish strata the model still discriminates — 0.612 / 0.707 / 0.804
top to bottom third — so it is not a proxy for the standings. It *is* weakest
for top-third teams, where going dark is rarest (6.6%) and most surprising.

**A consequence worth banking:** in-season standings would need per-week matchups
(18 more requests per league-season) and the final-standing figure bounds what
they could buy at roughly +0.02. Not worth the crawl.

### Measured on the default target

15,417 person-periods, all feasible, 2,269 positives (14.7%), manager-grouped
5-fold CV, logistic: **AUC 0.827**.

Positives are correlated within a manager-season — a manager who stops
contributes a positive row for every remaining week — so the effective sample is
smaller than the row count. Grouped CV handles that for evaluation; a model
fitted on these rows should weight or cluster accordingly.

---

## The survival model

`npm run train:abandonment` fits the discrete hazard
`h(w) = P(T = w | T >= w)` as a pooled logistic over person-periods — the
standard equivalence, so the whole model is one regression rather than a bespoke
likelihood. Chained across weeks it gives a survival curve and a season-level
abandonment risk. Source: [`src/lib/abandonmentModel.ts`](../src/lib/abandonmentModel.ts).

**Fit on every at-risk row, report on the feasible ones.** Under this failure
definition a manager can only die the week after transacting, so already-silent
rows have hazard exactly zero. They are genuine members of the risk set and
belong in the likelihood — but they are trivially separable, and scoring over
them inflates AUC from 0.766 to 0.873 with nothing learned.

### Weighting made it worse, and that is the finding

Equalising weight per manager is the obvious response to one manager holding 7%
of the rows. Measured, it degrades every metric:

| Weighting | AUC | Brier | Skill | Calib. slope | ECE | Concordance |
| --- | --- | --- | --- | --- | --- | --- |
| **none** | **0.766** | 0.0386 | 0.050 | **0.998** | 0.0088 | **0.643** |
| manager | 0.651 | 0.0466 | −0.146 | 0.196 | 0.0559 | 0.579 |

The reason is structural. A manager who quits in week 3 has two person-period
rows; one who plays the season has sixteen. Equalising per manager up-weights
early quitters roughly 8×, inflating the effective event rate far above the true
weekly hazard — the intercept chases it, calibration collapses to a slope of
0.196, and Brier skill goes *negative*. In survival analysis each person-period
row is a real observation of "at risk this week", and discarding the long
survivors' rows discards what makes the baseline hazard right.

**Clustering is a problem of inference and evaluation, not of the point
estimate.** Evaluation is handled by manager-grouped CV. Inference is handled by
cluster-robust (sandwich) standard errors, which sum score contributions within
each manager before the outer product.

That correction is verified by a known answer: duplicate every row four times
inside the same manager and the data carries no new information, so the naive
error halves while the robust error holds and the inflation factor doubles.
Remove the clustering and the same duplication doubles a coefficient's z from
−9.8 to −19.6 — significance manufactured out of nothing.

Inflation below 1 is not an error, and several features show it. A manager fails
at most once, so a positive score contribution at the failure week is offset by
negatives in their other weeks: the repeated rows are *constrained*, not
redundant, and for the dominant feature the clustered error is genuinely
smaller.

### Held-out performance

17,621 person-periods · 1,434 manager-seasons · 747 managers · 412 events,
5-fold CV grouped by manager:

**AUC 0.766 · Brier 0.0386 · calibration slope 0.998 · ECE 0.0088 · C 0.643.**

Calibration is the number that matters most: slope 0.998 and ECE under 0.01 mean
the output can be shown as a percentage rather than only used to rank.

Twelve of eighteen coefficients clear two robust standard errors.
`weeksSinceLastTxn` dominates (z = −19.9); `weekIndex` and `weeksSinceStart` are
indistinguishable from zero, so the baseline hazard is flat once behaviour is
accounted for.

### A bug worth recording

Season-level concordance first came out at **0.401 — below chance**. The cause
was scoring each manager-season by its chained survival across all its weeks: a
manager who fails in week 4 has three rows and one who lasts the season has
fifteen, so the product was dominated by how long each was observed, which is
inversely related to failing early. Using the hazard at the subject's first
at-risk week — a baseline risk, comparable across subjects — gives 0.643.

---

## Do leagues renew year over year?

`npm run analyze:renewal`. Sleeper links seasons backwards — a 2025 league names
the 2024 league in `previous_league_id`, and there is no forward pointer — so a
league-season counts as renewed when some other league-season in the corpus
names it as predecessor. Across 1,723 enumerated portfolios that is a
112,653-league-season pointer graph.

**Recorded renewal, by format** (2021–2025, lower bounds):

| Format | League-seasons | Renewed |
| --- | --- | --- |
| Dynasty | 57,809 | **73.7%** |
| Keeper | 2,765 | 69.3% |
| Redraft | 20,818 | 33.7% |
| Best ball | 31,261 | 20.2% |

Two corrections have to be applied before any of that is read as league survival.

**1. Censoring, and a Simpson's paradox on top of it.** A league is seen only
through observed managers, so one that renewed but lost all of them reads as
un-renewed. Aggregate renewal appears to *fall* as more of a league is observed
(56.1% → 27.4%), which inverts within format: dynasty rises 68.5% → 83.3%,
exactly as censoring predicts. The aggregate falls only because best ball — which
barely renews — goes from 13% of the 1-observer band to 66% of the 4-7 band.
Read the within-format rows; the pooled column is a composition artifact.

**2. `previous_league_id` measures Sleeper's rollover feature, not league
survival.** A dynasty league must roll over to keep its rosters. A redraft group
can just create a fresh league each August, which leaves the pointer null and is
indistinguishable from folding.

Tested directly: among league-seasons with no recorded successor where two or
more managers were observed, how often do two of them appear together in some
other league the next season? Random managers are drawn as a placebo, because
these managers play a median ~96 league-seasons and coincide constantly by
chance — only the lift is evidence.

| Format | No successor (2+ observed) | Reformed | Placebo | Lift |
| --- | --- | --- | --- | --- |
| Dynasty | 3,772 | 56.1% | 9.2% | **+46.9 pts** |
| Best ball | 19,638 | 86.0% | 19.5% | **+66.5 pts** |
| Redraft | 5,081 | 60.8% | 9.3% | **+51.5 pts** |
| Keeper | 113 | 44.2% | 6.2% | +38.1 pts |

### The answer

- **Dynasty: yes, measurable.** 73.7% recorded, ~83% among well-observed leagues,
  and still a lower bound. Dynasty has to roll over, so the pointer and the
  reality coincide.
- **Redraft: no, not from this field.** The recorded 33.7% is not a survival
  rate. In 60.8% of broken-chain cases the group demonstrably plays together
  again next season, against 9.3% by chance — the leagues are being recreated,
  not abandoned.
- **Best ball: the question does not apply.** These are single-season
  tournaments by design; 20.2% recorded renewal is the format working as
  intended, not churn.

Measuring redraft continuity properly needs co-membership rather than the league
chain — the same roster of people in any league, which is what the placebo-
controlled test above is a first cut at.

---

## Dynasty league member survival

`npm run analyze:dynasty-survival`. Dynasty only: rollover is mandatory to keep
rosters, so `previous_league_id` and reality coincide and lineages are
trustworthy. 137k dynasty league-seasons collapsing to 29,317 lineages.

Two things this gets right, both of which move the numbers:

- **A manager-season is at risk only if the league itself continues.** Otherwise
  a league folding is counted as every member quitting, which is a different
  event.
- **Membership is exact, not sampled.** Every portfolio was enumerated, so a
  manager still in the league next season appears in their own league list.
  Unlike league renewal, there is no censoring on the member side.

**Year-over-year survival: 84.8%** of 79,476 manager-seasons.

| Tenure entering the season | At risk | Stayed |
| --- | --- | --- |
| 1 year | 38,910 | 83.6% |
| 2 years | 21,688 | 84.1% |
| 3 years | 11,469 | 85.8% |
| 4+ years | 7,409 | **91.3%** |

### Survival from an observed join

Following genuine joins — absent one season, present the next — avoids
left-truncation. Kaplan-Meier, so a league folding **censors** rather than
counting as a departure.

| Years after joining | At risk | Left | Censored | Still in |
| --- | --- | --- | --- | --- |
| 1 | 5,349 | 1,427 | 2,188 | **73.3%** |
| 2 | 2,409 | 531 | 1,513 | 57.2% |
| 3 | 992 | 221 | 886 | 44.4% |
| 4 | 303 | 52 | 468 | 36.8% |

**Median tenure from joining: between 2 and 3 years.**

A first pass without censoring put year one at 52%, irreconcilable with the
84.8% year-over-year rate. The whole gap was league deaths being scored as
people leaving — the internal inconsistency is what exposed the bug.

### New members are the churn

Three figures that look contradictory and are not: 84.8% across all members,
83.6% at one year of tenure, but **73.3%** in the first year after an observed
join. The tenure bucket is left-truncated — a manager first seen in the earliest
observed season may have been there for years — so the join cohort is the honest
new-member rate, and the tenure table understates how differently newcomers and
veterans behave.

Caveat: 29% of joins are censored at the first step, since many lineages are
observed for only a short span. Kaplan-Meier handles it, but the later steps
rest on a much smaller risk set than the join count suggests.

---

## Per-member departure probability

`npm run model:dynasty-departure`. Unit: a (manager, dynasty lineage, season)
that is **at risk** — the lineage continues into the next season, so a league
folding is never scored as its members choosing to leave. 79,476 rows, base
departure rate **15.2%**.

Features come from the **enumerated portfolios**, complete for all 1,723
managers, rather than the crawled transaction slice which covers ~7% of each. A
behaviour-based feature set would be ~93% missing; a portfolio-based one is
exact.

### Validation by quintile

Temporal holdout — trained through 2024, tested on 2025 → 2026. AUC **0.675**,
calibration slope 1.100, ECE 0.023.

| Quintile | n | Mean predicted | Actual left | Lift |
| --- | --- | --- | --- | --- |
| Q1 (lowest risk) | 3,860 | 6.0% | **5.1%** | 0.39× |
| Q2 | 3,860 | 8.5% | 7.8% | 0.59× |
| Q3 | 3,860 | 10.6% | 10.4% | 0.79× |
| Q4 | 3,860 | 12.9% | 18.8% | 1.42× |
| Q5 (highest risk) | 3,860 | 20.5% | **23.9%** | 1.81× |

Grouped 5-fold CV by manager, all seasons: AUC 0.644, slope 0.840, ECE 0.012,
and quintiles 7.1% → 12.5% → 14.3% → 15.0% → **27.2%** (2.06×).

**Both ladders are monotone.** AUC in the mid-0.60s is modest, but the top
quintile leaves 4–5× as often as the bottom, and calibration is good enough to
quote the number rather than only rank on it.

### Reading the coefficients

`priorLeaveRate` dominates (0.459) — a manager who has left dynasty leagues
before leaves again, guarded to strictly earlier seasons. `logPortfolioSize` is
positive (spread thin across more leagues) and `seasonsActive` negative
(long-standing platform users stay).

**The tenure block is not interpretable.** `isNewMember` is definitionally
`tenureYears == 1`, so the fit splits weight arbitrarily and `isNewMember` even
comes out slightly negative — contradicting the survival analysis, where new
members clearly leave more (73.3% first-year survival against 91.3% for
four-year veterans). The univariate survival result is the reliable statement
about newcomers. Predictions are unaffected; the quintile tables are what
validate the model.

---

## Scoring a live dynasty league (Dynasty Retention view)

`src/lib/dynastyDeparture.ts` scores every current member from a league id, and
the **Dynasty Retention** view (Research nav, plus a link from any dynasty league
in Sleeper Leagues) renders a **1–5 grade** each.

**Cost: ~80–90 Sleeper requests** for a 12-team league — ~5 walking
`previous_league_id` back, ~5 rosters calls for membership history, ~72
portfolio calls (12 members × 6 seasons). A few seconds.

### The feature that does not survive the trip

`priorLeaveRate` is the strongest input, and computing it properly needs to know
whether a manager's *other* leagues carried on after they left. Their own
portfolio cannot say: once they leave, the successor never appears in it.
Offline this is resolved by pooling 1,723 portfolios; live, from one league, it
is not. So the shipped model uses an approximation — any disappearance counts as
a departure, unverified.

Measured cost of that, cross-validated and grouped by manager:

| Feature set | AUC | Q1 actual | Q5 actual | Monotone? |
| --- | --- | --- | --- | --- |
| full (offline) | 0.644 | 7.1% | 27.2% | yes |
| **live-approx (shipped)** | **0.604** | 9.6% | **23.5%** | yes |
| no prior-leave at all | 0.562 | 10.6% | 17.0% | **no** |

Dropping the feature breaks the ranking at the top — Q5 falls *below* Q4 — which
is the end that matters, so the approximation is the better trade.

### Verifying past exits — the toggle

Measured before building it. Verifying one departure costs ~3.5 requests
(`/league/<L>/rosters` plus a couple of co-member portfolio lookups), and
departures per manager run p50 **8**, mean **21.5**, p90 **53** — so a 12-team
league needs roughly **340 extra requests at the median member, ~880 at the
mean**, up to a few thousand for heavy players. Thirty to sixty seconds.

The obvious shortcut fails: co-members' portfolios are already in hand, but they
resolve only **7.8%** of departures. Dynasty league-mates rarely overlap in each
other's *other* dynasty leagues.

And the approximation is wrong often — the two definitions disagree on **57.9%**
of departures, those being leagues that folded rather than managers leaving.
(That figure is an upper bound: the pooled-portfolio ground truth is itself a
lower bound on league survival.)

So the view carries a **"Verify past exits"** toggle, default off:

| | Requests | AUC | Q1 → Q5 actual |
| --- | --- | --- | --- |
| off (approximate) | ~85 | 0.604 | 9.6% → 23.5% |
| on (verified) | ~400–1,000 | **0.644** | 7.1% → **27.2%** |

Each mode loads its **own fitted model** — `dynasty-departure-v1.json` and
`dynasty-departure-full-v1.json`, with their own grade cutpoints — because each
is calibrated to the inputs it actually receives. Scoring verified features with
approximate weights would be a quiet mismatch.

Two details that keep it honest:

- **Verified history is cached** for the page's lifetime, and safe to cache
  forever: whether a 2023 league rolled into 2024 is settled. Scoring several
  leagues pays per lineage once.
- **Budget exhaustion falls the whole league back** to the approximate feature
  rather than verifying some members and not others. Mixing two definitions of
  the same column across rows would be worse than using the weaker one
  consistently, and the report says which was used.

### Grades use fixed cutpoints

10.2% / 12.8% / 15.3% / 19.2%, taken from the cross-validated population and
shipped in `public/data/dynasty-departure-v1.json`. **Not** computed within a
league: grading relative to the twelve managers in front of you would guarantee
a grade 5 in a perfectly stable league and a grade 1 in a collapsing one. Fixed
cutpoints mean a grade means the same thing everywhere, and a healthy league can
legitimately come back all 1s and 2s.

Redraft is declined with a reason rather than scored. **Best-ball dynasty is
in scope** — it was wrongly excluded at first, and measuring it settled the
question: across 19,929 league-seasons, best-ball dynasty renews at 74.2% against
73.7% for the rest. Same behaviour, so same model; `isBestBallLeague` is a
feature rather than a gate.

## In the standings table

The League View standings table carries a **Leave Risk** column for dynasty
leagues, behind a **+ Leave risk** button. It is not loaded on render: ~80
requests is too much to spend on every visit to a league for a column most
visits will not read. One click fills it, and the column then sorts like any
other.

The cell is a grade badge plus the probability; the tooltip carries tenure,
portfolio size and past-exit rate. It links through to the Dynasty Retention
view — which owns the full explanation and the verify toggle — with the league
id already filled in.

Approximate mode only in the table. Verified scoring costs a few hundred more
requests and up to a minute, which belongs behind a deliberate click in the
dedicated view, not in a standings column.

The badge colours live next to the labels in `dynastyDeparture.ts` rather than
in either component, so the table and the view cannot drift on what a grade
looks like, and the test suite checks the two maps cover the same grades.

## Best ball has waivers (a correction)

"Best ball has no waivers and no lineups to set" was written into `wentDark()`
and the completeness audit, and half of it is false. Best ball removes the
**lineup**, not the waiver wire. Measured across 320 crawled league-seasons:

| | n | any txn | any waiver | any trade | median waivers |
|---|---|---|---|---|---|
| **Best ball / Dynasty** | 48 | **100%** | **93.8%** | **91.7%** | **157** |
| Best ball / Redraft | 126 | 26.2% | 4.8% | 0.8% | 0 |
| Standard / Dynasty | 124 | 98.4% | 97.6% | 96.0% | 159 |
| Standard / Redraft | 22 | 72.7% | 68.2% | 31.8% | 72 |

Best-ball dynasty is indistinguishable from standard dynasty. Best-ball
**redraft** is the locked case, and its marker is in the settings, not the
format: `waiver_type = 0` **and** `disable_trades = 1` covered 108 crawled
leagues and not one recorded a single waiver claim or trade. `waiver_type = 0`
alone is *not* "off" — 18 leagues carried it and 61% ran waivers.

So `LeagueFormatInfo` gains `txnEnabled`, derived from those two settings, and
the transaction guards key on it. The lineup guards still key on `bestBall`,
which is correct. Unknown settings count as enabled, so a dead league is never
excused by a missing field.

### What the old exclusion was costing

Skipping every best-ball row discarded **526 scorable manager-seasons** — 40% on
top of the 1,328 standard-dynasty rows — and discarded the format where this
signal is *strongest*, benchmarked within leagues that actually permit waivers:

| least-active quartile vs the rest | Q1 leaves | rest | χ² |
|---|---|---|---|
| **Best ball / Dynasty (waivers on)** | **38.3%** [27.1–51.0] | 14.8% [10.3–20.6] | **15.37, p<0.01** |
| Standard / Dynasty | 17.6% [11.6–25.8] | 17.8% [14.0–22.3] | 0.00, none |

Confidence intervals are Wilson; the best-ball pair does not overlap and the
standard pair is identical. The mechanism is plain: a standard-dynasty manager
must set a lineup weekly, so transactions are one channel among several. In best
ball there is no lineup, so waivers and trades are the *only* way to touch the
league and their absence says much more.

The effect is a threshold, not a gradient — Q2 (13.3%) sits below Q3 (18.3%), so
"barely transacted at all" is the signal rather than a smooth ranking. Sample is
243 labelled best-ball-dynasty manager-seasons from one seed portfolio's
neighbourhood, not a random sample of Sleeper.

## Draft grader

`src/lib/draftGrade.ts` scores every team in a Sleeper draft; the **Draft
Grader** view takes a draft id, a league id, or a URL.

### The grade is a description, not a forecast

`scripts/backtest-draft-grade.ts` graded 3,310 real team-drafts from 301
crawled league-seasons (2021–25) against how those seasons actually finished,
using the FFC ADP for that season only. Everything was measured within
league-season, since points-for scales differ enormously across leagues.

The first pass looked like a finding: getting players *later* than ADP
correlated with **fewer** points (r = −0.092) and reaching correlated with
**more** (r = +0.099), both significant — backwards from every published draft
grade, which was the tell.

It is lookahead bias. Every historical FFC snapshot is collected in the last
days before Week 1, and **263 of 301 drafts predate their own ADP file**, so the
ADP already prices in late-August news the drafter never had. An ACL tear on
Aug 28 collapses a player's ADP, so whoever drafted him looks like he got
enormous value, then scores nothing.

| metric | contaminated (2,965) | clean (344) |
|---|---|---|
| ADP value per pick | −0.103\* | 0.006 |
| ADP value total | −0.133\* | −0.001 |
| reach magnitude | +0.115\* | −0.013 |
| roster quality | +0.093\* | 0.064 |
| slot-adjusted | +0.152\* | 0.002 |

Every effect vanishes on clean data, and level metrics fare no better than
relative ones. Read it as no evidence rather than proof of zero: 344 team-drafts
from 31 leagues, skewed dynasty, ruling out only |r| > ~0.17.

So the shipped grade claims only what it can: how good a squad looks **on our
projections**, and how much of the board a manager captured. The panel says so.

### How it grades

Two numbers per team — projected points of the best legal starting lineup, and
the share of available value taken at their own slots. Replacement baselines
come from the league's own roster settings: a superflex slot moves the QB
baseline from 12th to 19th, and flex slots are split across the three eligible
positions rather than charged in full to each.

Grading is **relative to the league**, deliberately unlike the dynasty departure
grade's fixed cutpoints. Departure risk is an absolute property of a manager; a
draft is a competition against the other eleven teams in the room.

### Four bugs the real data found

Each was invisible in unit tests and obvious against a live draft:

- **The board was the whole projection pool.** In a rookie draft every "best
  available" resolved to a veteran who was never draftable, and capture rate
  read ~0% for all twelve teams. The board is now built from the players the
  draft actually took.
- **Rookie drafts are declined.** Even with the board fixed, replacement level
  is the 42nd-best RB in the NFL pool, so every rookie sits below it and nine of
  twelve teams still read 0% while receiving confident letters. Rookie pick
  value is multi-year dynasty value, not 2026 points.
- **F was unreachable.** The curve divided by `total`, putting the worst of
  twelve at 0.917; the bottom grade was decoration. Dividing by `total - 1`
  gives the promised 2/3/4/2/1.
- **"Took James Conner over Tennessee Titans."** Unprojected players enter at 0
  points, and K/DEF have no replacement baseline, so their VOR computed as
  exactly 0 — beating every genuinely below-replacement player.

## Status

| Step | State |
|---|---|
| Full transaction sweep | **done** |
| League lineage resolver | **done** |
| Engagement features, profile, segments | **done** (cold-start thresholds; centroids await a crawl) |
| Completeness + feature audit reporting | **done** |
| Manager-level features (portfolio enumeration, provenance, as-of guard) | **done** |
| Metric primitives (AUC, Brier, calibration, C, PSI, grouped CV, IRLS logistic) | **done** |
| To-date (person-period) feature recomputation | **done** |
| Abandonment survival model | **done** — weighted-fit study, cluster-robust inference, model card |
| League-exit model | not started — needs a crawl for lineage-level labels |
| Model-eval reporting (calibration curves, skill vs baselines, slices) | not started — blocked on the model |
| League-oriented crawler | **done** — needs seed league ids and a CI run to produce real numbers |
| Retrospective league-health panel | **done** |
| Dynasty Retention view (1-5 grades from a league id) | **done** |
| Leave-risk column in the standings table | **done** — opt-in, approximate mode |
| Best-ball waiver correction (`txnEnabled`) | **done** — unlocks 526 manager-seasons |
| Peer-relative activity feature in the departure model | not started |
| Draft grader (projection-based, league curve) | **done** — declines rookie drafts |
| MCP tool | not started |

Deliberately deferred: the injured-starter-hold feature and bye-week masking
both need the schedule/injury join, and shipping them half-done would put a
misleading signal into the abandonment model.
