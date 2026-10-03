# Devy rankings (2026-09-30)

Devy rankings for college QB/RB/WR/TE in the next three draft classes. The
headline is StatHead's **composite** value and rank (see "Composite" below),
built from two inputs:

- **The devy market:** KTC's devy prices for the ~100 players it lists, and our
  devy value model's price (which learns the market's pricing from college
  profiles) for everyone else.
- **Career score:** our NFL projection from the college profile.

**Rule: third-party values and ranks are inputs, never outputs.** KTC's devy
values, its ranks and its future-pick values feed the composite and the dynasty
scale. No field in `devy-rankings.json`, the Devy tab or `get_devy_rankings` is a
third-party number or rank:
- the market column is our value model's price, for every player, listed or not;
- the composite and dynasty values come from smooth curves fitted to the
  market's scale, not the market's own numbers.

Every value and rank exists separately for **superflex / 2QB** (`sf`) and
**single QB** (`oneQB`). Switching format switches all of them:
- the market inputs;
- the value model, which is trained on each separately;
- the QB replacement level in the career score;
- the future-pick curve.

The board is ordered by the composite and also priced on the dynasty scale, so a
college player can be weighed against NFL players and rookie picks.

- Site: the **Devy** tab (Dynasty group).
- MCP: `get_devy_rankings`.
- Data: `public/data/devy-rankings.json`.

## Pipeline

| step | script | runs |
|---|---|---|
| KTC devy market (SF + 1QB values, draft year, school) | `scripts/fetch-ktc.cjs` → `ktc_rankings_devy.json` | daily, `fetch-ktc-snapshot.yml` |
| Devy value model: KTC's pricing learned from college profiles | `scripts/train_devy_value_model.py` → `devy-value-model.json`, `devy-value-scores.json` | daily after the KTC fetch (~20 s), and with new CFBD data |
| Career model: NFL projection, trained and scored | `scripts/train_devy_model.py` → `devy-model.json`, `devy-model-scores.json` | with new CFBD data, `fetch-cfbd-college.yml` |
| Season to date: current season through the last week, plus the same cutoff for past seasons | `scripts/fetch_cfbd_inseason.py` → `cfbd/inseason/` | weekly in season, `devy-inseason.yml` (which also rescores both models and rebuilds) |
| Backtest and composite weights | `scripts/backtest_devy_value.py` → `devy-backtest.json` | monthly with new CFBD data |
| Board: two scores, composite, ranks and dynasty pricing | `scripts/build-devy-rankings.py` → `devy-rankings.json` | daily after the KTC fetch, and after a retrain |

Features are computed in `scripts/devy_features.py`, shared by both models.
Its `nfl_departed` filter drops anyone already in the NFL: drafted, or a 2026
rookie on a current roster with the same surname, first initial, position and
college. That catches nicknames, such as Texas A&M's "Kevin" Concepcion, who
is the Browns' KC Concepcion.

## Devy value model

**Question:** what would KTC's devy market pay for this college player?

- **Target:** log KTC devy value, superflex and 1QB, one model per format.
- **Training rows:** the 97 players KTC lists who match a CFBD profile (98 of
  100 match overall; the other two keep their KTC value and have no profile).

**Matching KTC names to CFBD:** by name and position, with three fallbacks:
- a changed or hyphenated surname at the same school (Ryan Williams is KTC's
  Ryan Coleman-Williams);
- a nickname at the same school;
- a transfer: same surname and position at another school, when that's a
  single 4-star+ recruit. "Hollywood" Smothers is Daylan Smothers, at NC State
  in the 2025 data and at Texas on KTC.

**KTC only lists its top ~100.** A regression on those alone would price every
unlisted player like a listed one. So the model has two parts:

1. **P(listed):** a LightGBM classifier over the whole current college skill
   population of 5,409 players. It asks whether KTC lists him at all.
2. **Value if listed:** a ridge regression on the listed players. LightGBM is
   also fit and reported; ridge ranks as well or better and is more stable on
   ~95 rows.
3. **Devy value** for an unlisted player = P(listed) × value if listed: what the
   market pays for a player like him, times the chance he's one it prices.
   Values are capped at KTC's 9,999.

   An earlier version blended toward the list's floor instead. That priced
   5,100 unlisted players at about 530, so a walk-on looked like KTC's #100.

**Features** (`MARKET_FEATURES`), as of the end of the last complete season:
- **Age:** estimated age and estimated draft age. CFBD, ESPN and KTC carry no
  college birthdates, so a high-school class of year R is taken as about 18.9
  at the end of its first college season. Without a recruiting record, the
  first college season is the earliest of his first CFBD season, his first
  ESPN stat-log season (any division) and, while active, the season his ESPN
  class implies (see "Ages and recruit links"). Redshirts and reclassified
  players are off by up to a year.
- **Breakout:** estimated age at the first season with a 20% dominator, 800
  scrimmage yards or 2,000 passing yards.
- **Team share:** best and last-season dominator, receiving and rushing yardage
  share, and CFBD usage rate (overall, pass, rush).
- **Raw counting stats:** last season's receptions, receiving yards and TDs,
  carries, rushing yards and TDs, and pass attempts, yards, TDs, INTs and
  yards per attempt; career receiving, rushing and passing yards and total TDs.
- **Program:** team recruiting talent, power conference, SP+ and SP+ offense.
- **Competition level:** whether he played at FBS last season, and his share of
  seasons at FBS.
- **Recruiting and body:** rating, stars, national rank, a talent-rich home
  state (FL, TX, CA, GA, LA, AL, OH), height, weight.
- **Efficiency and explosiveness:** yards per carry and per catch, longest play,
  return yards, fumbles lost.
- **Usage by down:** third down, passing downs, standard downs.
- **Team context:** pass rate, points per game, Elo, the best teammate's
  dominator (competition for targets), and whether he transferred or has
  played for more than one school.
- **Draft board:** consensus rank and projected pick, for the class that has
  one (2027). No board exists for past classes, so only this model uses it.
- **Position.**

That's 64 features in all. The value model is a ridge regression with its
strength tuned per format by cross-validation; alpha=100 wins, an interior
optimum of 10–1,000.

**Validation** (5-fold CV; players and folds sorted and LightGBM seeded, so
every run is identical):

| | superflex | 1QB |
|---|---|---|
| Value-if-listed Spearman with KTC, held out (ridge) | **0.73** | **0.68** |
| Same, recruit rating alone | 0.02 | 0.04 |
| R² of log value | 0.44 | 0.32 |
| Median error | ×1.41 | ×1.35 |

| Listing model (held out) | model | recruit rating alone |
|---|---|---|
| AUC, listed vs the 715 plausible unlisted prospects | **0.90** | 0.70 |
| Share of its top 98 that KTC lists | **63%** | 43% |
| AUC vs every unlisted FBS player (flattering; see below) | 0.96 | 0.83 |

**Audit.** An AUC of 0.96 looked like leakage, so it was checked:
- **Draft year leaked, a little.** Listed players carried KTC's own draft year
  and unlisted players an estimate (high-school class + 3). The draft-dependent
  features (seasons to draft, draft age) then differed by label: 13 of 98
  listed players had a year no unlisted player could. Features now use the
  estimate for everyone, and KTC's year only sets the class shown on the
  board. Effect: AUC 0.964 → 0.961, and 0.912 → 0.901 on the plausible set.
- **Most of the 0.96 was the comparison set.** Almost all of the 2,623
  unlisted FBS players are walk-ons and backups; recruit rating alone scores
  0.83 against them. The headline is now the plausible set: FBS players who
  were 4-star recruits or had 700+ scrimmage yards, 2,000+ passing yards or
  20%+ usage last season (715 players).
- **The draft board** (2027 class only) is public, available equally for
  listed and unlisted players, and is what the market reads, so it stays.
  Without it: AUC 0.894 and 60% on the plausible set.

**What drives it:**
- **Being listed:** team Elo and recruiting talent, recruit national rank and
  rating, power conference, touchdowns, passing-down and overall usage.
- **Price once listed:** position (TEs are discounted), breakout age, the draft
  board (the 2027 class), team Elo, program talent, and receiving production.
  Power conference weighs more in 1QB.

**What it can't see.** It learns the market's cross-section, so it inherits
the market's taste, not the truth. It also can't see what the market pays for
QB pedigree beyond the stats: the model prices a pedigreed QB like Arch Manning
well below the market, and the draft-board features only closed part of that
gap. The composite still uses the market's own price for listed players; the
model's price is what's shown.

## Career model

**Question:** what does a college player's profile say about his NFL fantasy
future, 0–3 seasons before he's draft eligible?

**Target (since 2026-10-03):** **hit**, at least one fantasy-starter season
in his first four NFL seasons: a season of 6+ games above replacement PPR
points per game (12 teams; 1QB QB13 / RB30 / WR42 / TE13, superflex QB25), per
format. Plus a **draft outlook**: Day 1 (round 1), Day 2 (rounds 2–3), Day 3
(rounds 4–7) or undrafted. See "Hit % and draft outlook" for why and how they
validate. (Until then the target was the mean of his best two PPR PPG seasons,
0 for a missing season or a player never drafted.)

**History:**
- Every CFBD QB/RB/WR/TE from 2005 on who was a 3-star+ recruit or produced
  (500+ scrimmage or 1,500+ passing yards in a season). The population is
  defined by the college profile alone. It used to admit every drafted player
  too, which selected on the outcome: 82 of 925 got in only by being drafted,
  so low-profile players who made it were in and their undrafted look-alikes
  weren't. Removing that lowered TE (0.50 → 0.46 at k=1) and QB slightly, and
  raised RB and WR.
- Draft classes 2010–2022, which have four NFL seasons to measure.
- One row per player per snapshot k = seasons left before the draft (0–3).
  Each row's features use only seasons up to that point.
- 17,825 snapshots of 4,880 players, 843 of them drafted.

**Features:**
- Recruiting: stars, rating, height, weight, and years since high school.
- Best and last season:
  - receiving yards and dominator (share of team receiving yards and TDs);
  - rushing yards and share;
  - scrimmage yards and TDs;
  - passing yards, yards per attempt, completion %, and (TD − INT) per attempt.
- Career rates and the season-over-season jump.
- A breakout marker: seasons into his career of the first 20% dominator,
  800-yard scrimmage season, or 2,000-yard passing season.
- Competition level:
  - team talent;
  - whether he played at FBS (the team has an SP+ rating) and his team's SP+.

  Without these, FCS quarterbacks' stats read like SEC stats.

- **Extended features, as in the value model:**
  - yards per carry and per catch, longest play, return yards, fumbles lost;
  - usage by down;
  - team pass rate, points per game and Elo;
  - the best teammate's dominator, and transfers;
  - recruit national rank and a talent-rich home state.

  That's 51 features. There are no draft boards: none exist for past classes.

The model is LightGBM, one per position, with k as a feature.

**Per format: points above replacement.** Raw PPG can't compare a QB with a WR,
and a QB's points are worth less in single-QB leagues. So the model is also
trained on the same target in PPR points per game **above replacement**, a
season below replacement counting 0. Replacement is the first non-starter in
a 12-team league (1 QB, 2 RB, 3 WR, 1 TE, 1 FLEX, plus 1 superflex), and its
level is measured as the median PPG at that rank over the 2016–2025 NFL
seasons:

| | QB | RB | WR | TE |
|---|---|---|---|---|
| single QB (QB13 / RB30 / WR42 / TE13) | 17.3 | 11.0 | 11.3 | 9.7 |
| superflex / 2QB (QB25) | 13.9 | 11.0 | 11.3 | 9.7 |

Only the QB line moves, so RB/WR/TE share one model and QB has one per
format. The career score on the board is this value in the chosen format.
Among 2027 prospects, the top 15 by career value has 1 QB in single-QB and 5
in superflex. Trinidad Chambliss is worth 1.08 PPG above replacement in 1QB
and 2.58 in superflex.

The Spearman figures for the above-replacement targets are lower (0.17–0.24
at k=1). Most players are exactly 0 above replacement, and those ties
depress Spearman. What the board uses is the expected value, which is what
makes positions comparable.

**Validation:** leave one draft class out at a time. Scored by Spearman
correlation with the outcome within each (class, k), and how many of each
class's actual top 12 the top 12 by each score catch:

| PPR PPG target, Spearman | k=3 | k=2 | k=1 | k=0 |
|---|---|---|---|---|
| QB model / production | **0.20** / −0.01 | **0.23** / 0.16 | 0.29 / **0.32** | 0.33 / **0.36** |
| RB model / production | **0.34** / −0.06 | **0.37** / 0.25 | **0.40** / 0.35 | **0.48** / 0.46 |
| WR model / production | **0.29** / −0.04 | **0.35** / 0.25 | **0.42** / 0.38 | **0.48** / 0.45 |
| TE model / production | **0.29** / 0.00 | **0.34** / 0.31 | 0.46 / **0.50** | 0.50 / **0.53** |

Recruit rating alone is 0.04–0.24 throughout.

- **Two or more years out (k = 2–3):** the model beats both baselines at every
  position. That's where devy value is decided, and where last-season
  production alone stops working.
- **In the last one or two seasons:** it beats production at RB and WR, and
  trails it at QB and TE.
- **On the above-replacement targets** (the career score on the board),
  production alone beats the model at QB and TE even at k=1. The model leads
  at k=2–3.

Full metrics are in `devy-model.json`.

### Competition calibration

Held out (2010–2022 classes), the career model's level is off by team strength.
Players from the weakest teams delivered well under their projected NFL PPG,
while other bands were close. The ranking within a class is fine. The fix is
`fit_calibration` in `scripts/train_devy_model.py`:

- **What it does:** one multiplier per position and competition band of his last
  season: below FBS, SP+ < −5, −5 to 5, 5 to 15, 15+.
- **How it's fitted:** on out-of-fold predictions, as the sum of actual over the
  sum of projected, shrunk toward 1 with 25 pseudo-players.
- **How it's validated:** nested by class, so each class is calibrated with
  factors fitted on the others.
- **Where it's applied:** to `careerPPG` / `careerScore` and to the backtest's
  career inputs.
- **How to turn it off:** `DEVY_CAREER_CAL=0`.

| Weakest band (SP+ < −5), actual ÷ projected | Before | After |
|---|---|---|
| QB | 0.52 | 0.93 |
| RB | 0.72 | 0.99 |
| WR | 0.95 | 0.99 |
| TE | 0.76 | 0.94 |

The other bands end up at 0.98–1.00. The effect on ranking is small:

- **Within-class Spearman:** QB −0.002, RB +0.002, WR 0.000, TE −0.007.
- **Composite backtest:** within noise, and the adopted weights are unchanged.
- **2023/2024 review:** mixed, at ±0.007.

The calibration changes the level, not the ranking. A small-school producer's
career PPG no longer reads 20–50% high.

## The board

- **Players:** as deep as the data goes. That's every current college QB, RB,
  WR and TE the value model scores (about 6,400 in 2026: the market's list,
  everyone else with college stats, and the incoming recruiting class), with no
  price cutoff. The on-disk value scores keep everyone, with prices to three
  significant figures.
- **Deep in the board:** values are small and flat. They show one decimal below
  10; past about #300 they are under 10, and past about #1,000 under 1. The rank
  carries the information there. Market z and career z are standardized over the
  whole pool, as in the backtest, which standardizes over each class's whole
  population.
- **Evidence (`profile.n_seasons`):** college seasons with stats, the current
  one included; 0 means recruit only. Most of the deep pool has one or two
  seasons, so its order leans on recruiting, age and a little production.
- **Players first seen this season** (no end-of-last-season profile, no
  recruiting record) are scored by the career model from the season to date for
  every class. Before, a class where the in-season replay didn't win was left
  unscored for them.
- **Order:** by composite, per format.
- **Market value / rank (`marketValue`, `marketRank`):** our value model's
  price, for every player. `marketListed` flags the players on the market's
  list.
- **Career score:** above replacement in that format, with its rank and
  percentile over the whole board. The raw PPG projection is shown next to it.
- **careerVsMarket:** market rank minus career rank in that format. Positive
  means the projection likes him more than the market model does.

## Composite

The composite blends the market and our projection, then prices the result on
a smooth curve fitted to the market's scale:

1. **Market z:** the normal score of his market-price rank over the board (the
   market's own price where it lists him, else the value model's): the same
   scale as the career side (see "Market and career on one scale" below). In 1QB, a listed
   player's market price is his superflex price through a per-position line
   in log value (see "1QB from superflex"), not the market's own 1QB price.
2. **Career z:** the normal score of his career-score rank over the board. Raw
   PPG breaks ties among the many players at 0 above replacement.
3. **Blend:** composite = (1 − w) × market z + w × career z.
4. **Price:** sort by the blend, and price each composite rank on a smooth
   value-by-rank curve: log value as a linear spline in log rank (knots at
   ranks 2, 4, 8, … 2048), fitted to the market's sorted prices, rounded to
   10. So `compositeValue` reads on the familiar 0–9999 scale, but no value
   shown is a market number. Every segment must slope down. Where the fit
   would rise between two knots, that knot is dropped and the curve refit.
   Before 2026-10-02 a clamp flattened such a stretch instead, and in 1QB
   that left 34 players (ranks 32–65) at the same 2,380.

**The weight w** starts from the career model's own held-out skill at the
player's position and distance from the draft (k = seasons until his draft
year, counted from the last complete season): 0.75 × its Spearman, halved where
it doesn't beat last-season production, clamped to 0.05–0.35. The build reads
it from `devy-model.json`, so it updates with each retrain.

**The design goal: stay close to the market, adjusted by the career model where
that validates better on NFL outcomes.** So the career weight is capped at 0.5
(the market always has at least half), and a weight fitted by the backtest (see
"Backtest" below) replaces the rule only where, on held-out classes, it
ranks better both within position and across the whole board. That's RB and WR
three seasons from the draft. Everywhere else the fitted weights were noise
around the rule, or helped one position at the board's expense, and the rule
stays. Today:

| Position | k=0 (2027 class, in season) | k=1 (2027) | k=2 (2028) | k=3 (2029) |
|---|---|---|---|---|
| QB | 0.13 | 0.11 | 0.18 | 0.16 |
| RB | 0.34 | 0.29 | **0.5** (backtest) | **0.5** (backtest) |
| WR | 0.34 | **0.5** (backtest) | 0.10 | **0.5** (backtest) |
| TE | 0.17 | 0.14 | 0.11 | **0.5** (backtest) |

(Weights as of the 2026-10-03 rerun on the rank scale.)

The market leads everywhere, and QBs move least because the QB career model is
the weakest. Three seasons out the value model has little to go on (it's fit on
a KTC list that's almost all 2027–2028 players), so RB and WR get an even blend
there.

**How close it stays to KTC (2026-10-03, rank scale):** among the 100 players
KTC lists, composite value against KTC's own value is 0.813 in superflex
(0.713 in 1QB). Eight of the market's top 10 and 40 of its top 50 stay there in
superflex (8 and 35 in 1QB). Over the whole board the rank correlation of
composite and market model is 0.86: deep, unlisted players three seasons out
move a lot, since the career model carries half their weight there. The top 50
sits closer to the market than before (median move 12 places, was 17).

**How far it moves the board (composite rank vs the market model's rank, profiles through 2026 week 4):**

| Format | Median move | Max move | Top-50 overlap with market |
|---|---|---|---|
| Superflex / 2QB | 269 | 6,052 | 40 |
| 1QB | 380 | 6,068 | 35 |

(2026-10-03, rank scale. The large moves are deep, unlisted players three
seasons out, where the career model carries half the weight; Taylor Tatum,
listed but with no college record, is priced on the market alone.)

Fields: `compositeValue`, `compositeRank`, `compositePosRank` and
`compositeWeight` (per format).

### Market and career on one scale (2026-10-03, later)

The market side was the z-score of log price over the whole board. Over ~6,100
players, mostly cheap, every market-listed player scored 4.5–5.5, while the
career side (a normal score of rank) tops out at 3.8 for #1. So for top
players the career side always sat below the market side, and a heavier
career weight pulled them down:

- Jeremiah Smith, #1 on both inputs, ranked #9 in superflex (career weight
  0.5); Malachi Toney, market #2, ranked #41.
- Trey'Dez Green, market about #12 and career #39 in 1QB, ranked #2 on a light
  TE weight (0.14).

Now the market side is the normal score of the price rank, on the same scale.
Backtest on the 2010–2022 classes, same snapshots, shipped weights, each
class's top 100 by value (the traded part of the board), Spearman with points
above replacement:

| k | Superflex: log → rank | 1QB: log → rank | Superflex top-24 hits |
|---|---|---|---|
| 0 | 0.395 → **0.402** | 0.378 → **0.387** | 9.85 → **10.08** |
| 1 | 0.283 → **0.293** | 0.292 → **0.305** | 8.08 → **8.38** |
| 2 | 0.267 → **0.275** | 0.265 → **0.276** | 7.23 → **7.46** |
| 3 | 0.108 → **0.131** | 0.129 → **0.156** | 2.46 → **2.62** |

Within position it's equal or better everywhere; over every profile player
it's within 0.003 (k = 3: 0.138 → 0.135 superflex). The adopted weights were
refit on the new scale: RB k = 2 now adopts 0.5 and WR k = 2 falls back to the
rule. `DEVY_MARKET_Z=log` reruns the old scale for comparison.

New top of the board: superflex Jeremiah Smith, Malachi Toney, Arch Manning,
Darian Mensah, Ryan Coleman-Williams; 1QB Smith, Toney, Coleman-Williams, Bo
Jackson, Jadan Baugh. Green is TE1 at #13 in both.

Also from the rerun: on the top-100 boards the career model alone now edges
the capped composite at every k (superflex k = 0: 0.423 vs 0.402). The cap
(the market keeps at least half) is a design choice, not what the backtest
alone would pick.

### One order within a position (2026-10-03)

Format changes where a position sits against the others, never the order
within it. A QB's worth against other QBs doesn't depend on how many QBs start.
The career half of the blend differs by format: it's value above QB13 vs QB25
replacement, standardized over the whole board. On its own that reordered
players within every position. Before this fix, 37–49 of each position's top 50
had a different position rank in 1QB (Demond Williams Jr. QB14 in superflex,
QB20 in 1QB).

So the superflex blend sets the order within each position, and each position
keeps the 1QB blend's own scores, handed out in that order. `compositePosRank`
is now identical in both formats. `compositeRank` and `compositeValue` still
differ, because the 1QB blend still moves positions against each other: QBs
fall, and the 1QB top 100 still holds 31 QBs, 33 WRs, 28 RBs and 8 TEs.
Superflex is the reference because its QB career scores are above a deeper
replacement level, so fewer QBs tie at zero.
`marketPosRank` and `careerRank` stay per format: they describe each input.

### 1QB from superflex (2026-10-02)

The market's own 1QB devy prices are noisy against its superflex prices, most
of all at QB. Regressing log 1QB price on log superflex price per position over
the listed players leaves a residual SD of 0.59 at QB, against 0.15–0.24 at RB,
WR and TE. That noise reordered QBs by format with nothing about the players
changing: Chambliss was the 1QB QB1 and Mensah QB4, while superflex had Mensah
QB1.

So the 1QB composite takes each listed player's superflex price through that
per-position line (OLS, `one_qb_map` in `scripts/build-devy-rankings.py`; a
pooled line for a position with fewer than 5 listed). Within a position the
market input keeps the superflex order. The format moves positions against
each other, and the career model (above replacement in 1QB) adds the rest.
Unlisted players keep the value model's own 1QB price.

Effect on the 1QB board, this change alone: Mensah #10 → #4, Chambliss
#4 → #8, Jayden Maiava #26 → #11, Keelon Russell #27 → #18, Drew Mestemaker
#111 → #23. With the age fix and retrain the same day (see "Ages and recruit
links"), the 1QB QBs read Manning #4, Mensah #7, Moore #8, Chambliss #9, and
superflex reads Manning #1, Mensah #3, Moore #4, Chambliss #6. Top-300 rank
correlation with the previous board: 0.94 superflex, 0.93 1QB. The backtest
refit also adopted a 0.5 career weight for QBs three seasons from the draft.

## Backtest: value, career and composite on past classes

`scripts/backtest_devy_value.py` → `devy-backtest.json`. The value model
learns what KTC pays for a profile today and has never seen an NFL outcome, so
it can be scored as is on past classes:

- **Population:** every 2010–2022 college snapshot the career model trains on
  (18,490 snapshots of 5,059 players, k = 0–3), each priced by the value model
  from his profile at that point.
- **Career side:** the career model's leave-one-draft-class-out predictions.
- **Composite:** built as on the board.
- **Outcomes:** first-two-season PPR PPG, best two of the first four, and
  points above replacement per format.
- **Pools:** each draft class at each k; "top 100" = the 100 the value model
  prices highest (the tradeable part of a devy board). Spearman is averaged
  over classes. Hits = of the top 24 by the score, how many finished in the top
  24 among players who produced at all.

**Whole board, top 100 per class, superflex points above replacement:**

| k | Value model | Career model | Composite |
|---|---|---|---|
| 0 | 0.333 | 0.367 | **0.379** |
| 1 | 0.270 | 0.270 | **0.306** |
| 2 | 0.254 | 0.238 | **0.278** |
| 3 | 0.057 | **0.208** | 0.133 (0.146 RB / 0.164 WR cells with the adopted weights) |

**Within position, first two seasons PPG, all profile players:**

| k | Value model | Career model | Composite |
|---|---|---|---|
| 0 | 0.462 | 0.430 | **0.471** |
| 1 | 0.415 | 0.376 | **0.424** |
| 2 | 0.307 | 0.308 | **0.333** |
| 3 | 0.127 | **0.261** | 0.181 |

- The value model predicts production well for players in their last two
  seasons. Within position it beats the career model, having only learned from
  KTC prices.
- The composite beats the raw value model at k = 0–2 on both measures.
- At k = 3 the value model is close to useless and the career model should
  carry the weight.

**Weights:** per position and k, the backtest picks the blend weight (0 to 0.5:
the market always leads) that best ranks each class's top 100 within position
(mean of the two PPG outcomes). It checks each weight leave-one-class-out: each
class is scored with the weight chosen on the other twelve. A fitted weight is
adopted only where, held out, it beats the shipped rule within position by 0.01
or more AND lifts the whole board by 0.005 or more in both formats.

Until 2026-10-02 the board test was only "not worse", so ties passed. The 2026-10-02
rerun shows why that changed. QB k = 3, RB k = 2 and TE k = 1 each beat the rule
within position by 0.013–0.037, but on the whole board they only tied or won by
0.001–0.006. Yet adopting them moved top 2027 TEs sharply (Trey'Dez Green #36 →
#124 in superflex). They are not adopted.

The later 2026-10-02 rerun, after the recruit-link and age fixes (see "Ages and
recruit links"), adopted QB k = 3 at 0.5 (dropped again on 2026-10-03; see
"Off-roster players and recruit ids"). Held out it scores 0.208 within
position against 0.185 for the rule, and it lifts the whole board in both
formats: superflex 0.119 → 0.124, 1QB 0.115 → 0.131. QB k = 3 is the 2029 class.

- **Adopted:** RB and WR at k = 3, 0.5 each.
- **Dropped:** QB and TE at k = 3, and RB and TE at k = 2. Each helped its own
  position but cost the whole board, e.g. TE k = 3 at 0.120 vs 0.133 superflex.
- **Uncapped:** without the cap, the fit wanted 0.7–1.0 at k = 3, which would
  rank the 2029 class almost purely by the career model.
- **k = 0–2:** the fitted weights did no better held out than the rule.

**Caveats:**

- Historical snapshots use the player's actual draft year, so both models know
  who left school early. That inflates every number above, for both sides
  equally.
- Draft boards didn't exist for past classes, so the value model's board
  features sit at "not on a board" throughout.
- The monthly CFBD workflow reruns the backtest and refits the adopted weights.

**Out-of-sample classes (`scripts/devy_class_review.py` → `devy-class-review.json`).**
Neither model has seen the 2023 or 2024 class: the career model trains on
classes with four NFL seasons, and the value model on today's players. Top 100
per class, just before the draft, against NFL PPR PPG so far:

| Class | Test | Value model | Career model | Composite |
|---|---|---|---|---|
| 2024 | Whole board | 0.451 | **0.522** | 0.512 |
| 2024 | Within position | **0.599** | 0.553 | 0.550 |
| 2023 | Whole board | **0.331** | 0.247 | 0.300 |
| 2023 | Within position | **0.574** | 0.418 | 0.470 |

Two classes are a small sample (a few dozen producers each), so read this as
consistent with the backtest, not proof.

**Training-data fixes (2026-09-30):**
- **Blank positions.** CFBD leaves the position blank ("?") on ~1,150
  player-seasons, mostly 2007–2018 and disproportionately productive (Nick
  Chubb, Sony Michel, Giovani Bernard). Those players were dropped from every
  QB/RB/WR/TE filter. `fix_positions` fills the position from the player's
  other seasons, else from his stats (never from the draft). 179 more players,
  665 more snapshots.
- **Nickname draft joins.** The draft join matched on full name only, so "Mar'Keise"
  Irving (Oregon) never met the Buccaneers' Bucky Irving and counted as
  undrafted with 0 NFL points. It now falls back to surname + position + school
  when exactly one college player claims the pick (24 more matches). School
  aliases (Ole Miss / Mississippi) are learned from the name matches.
- **Still missing:** some stars have no CFBD player-season record at all (Cam
  Newton 2010, Todd Gurley, Duke Johnson, Will Fuller). Filling those needs a
  second college-stats source.

## Season to date

During the college season (`scripts/fetch_cfbd_inseason.py`, weekly by
`.github/workflows/devy-inseason.yml`, Sundays August–January) the models see
this season's stats. The CI run pulls the current season through the last
completed regular-season week, plus the same week cutoff for every past season
since 2005 (~25 CFBD calls on a new week, ~5 after). It stores them compactly
under `public/data/cfbd/inseason/`.

- **Full-season estimate.** The models are trained on whole seasons, so a
  season-to-date line is turned into a full-season line first. For each
  position and stat, a regression fitted on history (week-W total → full
  season) combines the season-to-date total prorated to the team's schedule,
  last season's total, and whether he had one. It never goes below what he
  already has.
- **How much better than prorating** (R² of the full season at week 4):

  | Stat | Estimate | Prorated only | Last season only |
  |---|---|---|---|
  | WR receiving yards | 0.78 | 0.65 | 0.15 |
  | RB rushing yards | 0.77 | 0.69 | 0.12 |
  | QB passing yards | 0.83 | 0.73 | 0.14 |
  | TE receiving yards | 0.75 | 0.57 | 0.11 |

- **Team context as known at the cutoff.** SP+ and usage by down are last
  season's: the final SP+ is set by games not yet played, and CFBD has no
  weekly usage to replay. Team scoring and Elo run through the week.
- **Career model: replayed, then blended.** Inside the leave-one-class-out
  folds, every past player is re-scored at week W of a season: his profile to
  the season before, plus the estimate. That's compared with the
  end-of-previous-season snapshot, same players, against the NFL outcome. A mix
  of the two, (1 − a) × last season's projection + a × the season-to-date
  projection, is also tried, with a ∈ {0, 0.25, 0.5, 0.75, 1} chosen on the
  other classes. The live weight is whichever option wins held out at that
  position and class (`devy-model.json` `inSeason.usedFor`; on the board,
  `inSeason.careerInSeasonWeight`). At week 4, held-out Spearman, last season →
  season to date → blend:

  | Position | 2027 class | 2028 class | 2029 class |
  |---|---|---|---|
  | QB | 0.312 → **0.342** → 0.333 (100%) | 0.234 → **0.291** → 0.288 (100%) | 0.204 → 0.197 → **0.211** (25%) |
  | RB | 0.389 → 0.425 → **0.427** (75%) | 0.364 → 0.324 → **0.374** (25%) | 0.333 → 0.322 → **0.357** (50%) |
  | WR | 0.416 → **0.447** → 0.442 (100%) | 0.335 → **0.383** → 0.369 (100%) | 0.291 → 0.313 → **0.323** (75%) |
  | TE | 0.464 → **0.515** → 0.515 (100%) | 0.354 → **0.448** → 0.440 (100%) | 0.302 → **0.309** → 0.306 (100%) |

  Before 2026-10-02 this was a switch, so 2029 QBs and 2028–2029 RBs ignored the
  season to date entirely.
- **The 2026 schedule bug (fixed 2026-10-02).** The season's games file is
  camelCase (CFBD v5 client), and `team_schedule` read snake_case. As a result
  the live season-to-date lines were never prorated: a WR with 617 yards in four
  games was estimated at 657 for the season instead of about 1,490. The team
  scoring and Elo context for 2026 were also empty. History was unaffected, so
  the replay above was always right; only the live scores were wrong. The fix
  moved the board substantially (rank correlation 0.92 with the previous one).
  For example, KJ Duff went from #51 to #32, and Sam Leavitt from #22 to #79.
- **Opponent strength was tested and rejected.** Adding opponents' prior-season
  SP+ through week W (and production × that) to the estimator did not improve
  the full-season estimate held out by season. The change in R² was +0.0005 QB
  passing yards, +0.0001 RB rushing, +0.0003 WR receiving and −0.0002 TE
  receiving, and minor stats got worse. This matches the career-model test,
  where schedule strength added nothing.
- **Value model: it's fit to today's KTC,** which already prices this season,
  so its profiles run through the current week. Held-out Spearman against KTC:

  | Format | End of 2025 | Through 2026 week 4 |
  |---|---|---|
  | Superflex | 0.726 | 0.797 |
  | 1QB | 0.677 | 0.707 |

  (Measured after the schedule fix.)

  Listing accuracy is flat (AUC ~0.89–0.90 against plausible unlisted
  prospects).
- **Pool.** Players with 2026 stats join (transfers, new starters: Ashton
  Daniels, Rocco Becht, Evan Stewart). A player with no stats yet this season
  who'd be in his fifth college year or later is dropped as out of
  eligibility (Diego Pavia, Kyron Drones).
- The composite weight's k still counts from the last complete season: a few
  games in, the profile is still mostly last year's.
- Once the complete season is on disk (February), the in-season files are
  ignored and the full-season fetch takes over.

## Dynasty scale

Within each class, a player's composite rank is his expected rookie-draft slot:
with 12 teams, 1–4 Early 1st, 5–8 Mid, 9–12 Late, and so on. That slot is
priced on a smooth curve (log value, quadratic in slot) fitted to the market's
future-pick values for that year and format, rounded to 10.

- The 1.01 and 1.02 are capped at +25% of the fitted Early-1st price, because a
  near-certain 1.01 is worth more than an average Early 1st.
- A 2028 player is priced as a 2028 pick, which the market discounts against
  2027, so the same class rank is worth less a year further out.
- **Class depth on the board isn't the true class depth.** The value model
  prices a 2027 upperclassman with production above an unproven 2028 player, so
  a 2027 player 50th in his class ("beyond round 4") can be worth less on the
  dynasty scale than a 2028 player 40th in his.

## High-school board

The High School tab and MCP `get_hs_prospects` rank high-school recruits who
aren't in college yet: QB, RB, WR, TE and ATH.

**Model:** `scripts/train_devy_hs_model.py`.

- **Training set:** every high-school skill recruit in the 2007–2016 classes, busts included. A class's draft window is the class year plus 3 to 6, which is measured through 2022.
- **Draft links:** recruits are linked to the draft by name within that window, with school breaking ties. CFBD athlete ids cover only 20–60% of the older classes.
- **Target:** the career model's target. That's the mean of a player's best two NFL seasons in his first four, in PPR points per game, raw and above replacement per format, plus P(drafted at a skill position).

**What we learned:**

- Held out one class at a time, nothing beat the recruiting composite rating at ordering a position.
- We tried height, weight, BMI, dual-threat and all-purpose sub-positions, the committed program's talent and SP+, and a boosted model of the rating. All of them did worse.
- So the model is the rating, calibrated per position group on a smooth increasing curve: a Tweedie GLM with log link and power 1.2 for value, and a logistic for P(drafted).

**What it adds:** a cross-position, per-format scale. Superflex lifts QBs, from 11 to 25 of the 2026 class's top 100.

- Across a whole class it orders NFL outcomes as well as the raw rating does, but not better. Held-out rank correlation is 0.127 vs 0.127 in superflex and 0.123 vs 0.125 in 1QB.
- Its order differs from the composite's national order: rank correlation 0.83–0.85, with 82 of the top 100 shared.

**No position rank or position filter:** within a position the order is the composite's, so showing either would show a third-party ranking. See `docs/third-party-data-policy.md`.

**Data:**

- `scripts/fetch_cfbd_recruits.py` refreshes the last enrolled class and the three classes behind it, writing snake_case keys.
- It runs in `devy-inseason.yml`: weekly in season, plus monthly February to July.

## Recruiting data fix (2026-10-01)

The CFBD v5 client writes camelCase keys (`athleteId`, `committedTo`), but the
devy loaders read snake_case. As a result, the whole 2026 recruiting class was
invisible to both devy models:

- No current player was linked to a 2026 recruiting record.
- The value model gave true freshmen 0 stars.
- Recruits with no stats weren't scored.

The fix:

- `load_recruits` now accepts both key styles, and missing grades load as None instead of NaN.
- The recruit fetcher writes snake_case.
- `recruiting-2026.json` was converted.

The effect:

- 868 players are now linked to the 2026 class, and the board grew from 6,441 to 7,047 players.
- Elite true freshmen moved up. For example, Keisean Henderson went from #715 to #155, and Savion Hiter from #451 to #108.
- The board's order correlates 0.94 with the previous board, and the models' held-out metrics moved by at most ±0.014.

## Ages and recruit links (2026-10-02)

An audit of the board's ages found two problems, both fixed in
`scripts/devy_features.py`.

**Recruits without a CFBD player id.** CFBD leaves `athlete_id` empty on 54%
of its recruiting records, among them 4-stars such as Demond Williams Jr. Those
players had no stars, rating or recruit rank, and their age was dated from their
first CFBD season. They are now linked by name, to a player whose first CFBD
season falls within three years of the class. A match at the school he
committed to comes first; otherwise the link needs a unique match at a
compatible position. Testing the rule on recruits CFBD does link (hide the id,
rerun): 97.6% right on the school match, 89% on name alone before the position
check. Linked recruits went from 31,400 to 43,000. In the top 1,000 on the board,
118 players gained their recruiting record.

**Players with no recruiting record** (unrated recruits, walk-ons, JUCO and
lower-division transfers: 261 of the top 1,000 after linking) were dated from
their first CFBD season. That misses redshirt years and every season below
FCS: Trinidad Chambliss (Ferris State, then Ole Miss) read as 19.9.
`scripts/fetch_espn_college_entry.py` now records, from ESPN (whose college
athlete ids are CFBD's), his first stat-log season in any division and, while
he is active, his class. The entry season is the earliest of those and his
first CFBD season (at most four years earlier), written to
`public/data/cfbd/college-entry.json`. Of 14,534 players without a recruit,
about 4,000 entered earlier than their first CFBD season: 2,243 by a year,
1,167 by two, 646 by three or more. Chambliss now reads 21.9. Class is a floor,
so ages stay conservative. Only seasons and class are used, nothing ESPN rates.

**Validation** (career model, held out one draft class at a time, on the same
18,490 snapshots for every variant; mean per-class Spearman, 90% bootstrap
interval over classes):

| Target | Before | + recruit links | + ESPN entry |
|---|---|---|---|
| QB PPG | 0.273 | 0.283 | 0.286 |
| RB PPG | 0.390 | 0.390 | 0.395 |
| WR PPG | 0.389 | 0.392 | 0.389 |
| TE PPG | 0.401 | 0.416 (+0.015, [+0.001, +0.030]) | 0.410 |
| QB superflex VOR | 0.160 | 0.200 (+0.040, [+0.009, +0.067]) | 0.190 (+0.030, [+0.004, +0.055]) |

Recruit links help. ESPN entry is neutral on history, as expected: the class
bound exists only for current players, and that is where it corrects ages.
The value model (held-out rank correlation with the market's prices) is
unchanged within noise: superflex 0.797 / 0.800 / 0.800, 1QB 0.707 / 0.698 /
0.694, over 97 listed players. Both changes are adopted, the second as a data
correction. Off switches for comparisons: `DEVY_RECRUIT_LINK=0` and
`DEVY_ESPN_ENTRY=0`.

## Off-roster players and recruit ids (2026-10-03, issue #540)

Drip found 749 board players that ESPN marks inactive this season, several
ranked high: Devonte Ross was #95 in 1QB. The only in-season filter was
"no stats this season and a fifth college year", and it dated college entry
from the recruiting class or first CFBD season, missing ESPN's earlier years.

- **Roster check.** `scripts/fetch_espn_college_entry.py` also writes
  `public/data/cfbd/rosters-<season>.json`: every player on an FBS or FCS
  roster this season (ESPN, 266 rosters, 29,704 players; the other 12 ESPN
  "teams" are all-star and placeholder entries). In season, the value model
  drops a player who is on no roster and has no stats this season at an
  FBS/FCS school. Stats at a Division II school (Savannah State's games against
  FCS teams) don't count. FBS/FCS schools are the CFBD team names with a
  rostered player in this season's stats.
- **Eligibility rule** now uses the ESPN entry season too (`college_entry`).
- **Recruit ids.** CFBD's own `athlete_id` is sometimes another player's: it put
  Roydell Williams's id (FSU, in college since 2020) on Hykeem Williams's 2023
  5-star record. A CFBD link is now kept only when the names agree: the
  surnames contain one another and the first names share an initial. Otherwise,
  and when the id has no stats, the record is linked by name. 1,168 of 18,483
  CFBD links had a different first or last name; most are nicknames
  (Rob / Robert), which pass.

Effect (week 4 board, after a full retrain): 800 players left the pool for
being off any roster, and the board went from 6,996 to 6,130 players. 868 rows
left in all: 7 from the 1QB top 300 and 48 from the top 1,000. All 15 of Drip's
examples are gone. Six players with FBS/FCS stats but missing from ESPN's
rosters stay, which matches Drip's count of ESPN gaps. Top-300 rank correlation
with the previous board: 0.955 superflex, 0.952 1QB. Position ranks still match
across formats.

The id guard is neutral on the career model. Held out on the same 23,905
snapshots, every position moved by less than ±0.004, inside the 90% intervals
(off switch `DEVY_RECRUIT_GUARD=0`). The backtest refit now adopts only WR
three seasons out. QB and RB k = 3 still win within position (0.222 vs 0.211,
0.284 vs 0.220) but no longer lift the superflex board by 0.005 (+0.002 and
−0.001), so they fall back to the rule weight.

## Hit % and draft outlook (2026-10-03)

**Why the career target changed.** `careerPPG` was the expected mean of a
player's best two NFL PPG seasons, with 0 for anyone who never played. 89–93%
of college players are zeros, so a prediction was mostly "chance he makes it ×
how good he'd be". It read like a weekly PPG but wasn't one: Arch Manning at
3.0, several top-24 players negative, TE5 Luke Hasz at 0.01.

**What was tested** (24,580 snapshots, 2010–2022 classes, held out by class):

| Option | Held out | Verdict |
|---|---|---|
| Hit chance (starter season in the first four) | AUC 0.72–0.96 | Predictable; ranks NFL value above replacement better than the old regression in all 20 position × distance × format cells (WR one season out 0.279 vs 0.204, TE final season 0.298 vs 0.207) |
| × value if he hits | +0.000 on top of hit chance | No gain |
| PPG if he hits / if he plays | Error no better than the position average (WR 4.2 vs 4.4 PPG) | Not predictable beyond the position's range |

So the board shows **hit %** (`hitProb`, per format, percent) and a
position-level **hitPPG** range (p25 / median / p75 best-two-season PPG of
past hits). `careerPPG` and `careerScore` are gone.

**Calibration.** Raw hit chances ran low on most competition bands and a little
overconfident at the top. A per-position logistic in the raw log-odds with an
offset per SP+ band, fitted on out-of-fold predictions, fixes both. Validated
nested by class, actual ÷ predicted hits by band is 0.98–1.02, and the top bins
run about 0.1 high (WR 78% predicted vs 66% actual, n=32). The multiplicative
band factors used for the PPG target broke at the top: held out, WRs called
98% hit 62% of the time.

**Across positions** a hit isn't worth the same. The career rank (and the
composite's career z) uses hit chance × **hitValue**, the mean PPG above
replacement of past hits at his position in that format. Within a position the
order is the hit chance's. On the high-school board, ranking by hit chance alone
lost to the raw rating across positions (0.088 vs 0.124); with hitValue it beat
it (0.125).

**Composite backtest** (vs the previous career target):

| Seasons before draft | Superflex | 1QB |
|---|---|---|
| Final season | 0.379 → 0.395 | 0.370 → 0.378 |
| 1–3 seasons out | within ±0.01 | within ±0.01 |

The backtest now adopts a 0.5 career weight for WRs one, two and three seasons
out, and for RBs and TEs three seasons out. Board top-300 rank correlation with
the previous board: 0.91 superflex, 0.90 1QB.

**Draft outlook** (`draftOutlook`: day1 / day2 / day3 / undrafted, percent). One
LightGBM 4-class model per position. Class shares are rescaled to held-out base
rates (nested, shrunk), which helps a little (QB one season out, log loss
0.431 → 0.421).

| Granularity | Held out | Verdict |
|---|---|---|
| Day 1 / 2 / 3 / undrafted | Beats the base rate from the final season to two out; Day 1 AUC 0.94–0.97 in the final season | Shipped |
| By round (7 + undrafted) | Loses to the base rate from one season out | Rejected |
| Early / mid / late within a round | Loses everywhere; 1–5% land in the predicted third | Rejected |

Three seasons out (the 2029 class) the outlook beats the base rate for RB and WR
but not QB or TE (log loss 0.595 vs 0.590, 0.659 vs 0.654), so those players
show none.

**Where a projected pick exists, it leads (2026-10-03, later).** College stats
alone can't see what decides a draft slot (arm, size, traits, scouting): one
season out, the model gave Justin Herbert 7% and Jared Goff 4% for round 1, and
on the first build it put Arch Manning and Darian Mensah most likely on Day 3.
College QBR / EPA (ESPN, 2004–2020) added nothing held out (Day 1 AUC 0.913 →
0.914), nor did the value model's market-style price as a feature.

Tested out of sample on the 2026 draft: the final draft model (trained on
classes through 2022) scored the 2023–2026 classes (`DEVY_DRAFT_REVIEW=1` with
`DEVY_CAREER_DUMP`), and the 85 skill players on StatHead's 2026 big board were
scored against their actual day:

| Draft chances from | Round-1 log loss | 4-day log loss |
| --- | --- | --- |
| Board alone, smooth pick → day curve | **0.105** | **0.802** |
| Board alone, pick bins (the old mapping) | 0.134 | 0.873 |
| 75% board curve / 25% college model | 0.131 | 0.892 |
| 50 / 50 (the old blend) | 0.164 | 1.037 |
| College model alone | 0.352 | 1.783 |

Among those players the college model's round-1 AUC was 0.75; the board's was
0.97. So the outlook now uses, in order:

1. **Board** (`source = "board"`, nearest class): the player's big-board pick
   (`career-2027.json` projPick) through the last draft's projected pick →
   actual day curve (`prospect-grades-2026.json`; three cumulative logistics in
   log pick: round 1, rounds 1–3, drafted). That board was read at the draft;
   ours is read in season, before declarations, injuries and the combine, so
   the curve is widened 15% toward the day shares of all board prospects
   (`BOARD_EARLY`; a judgement, there are no archived October boards). No
   college model.
2. **Early mock** (`model+mock`, later classes; WalterFootball's Charlie
   Campbell mock, about two years ahead, round 1 only, `scripts/fetch_walter_mock.py`
   → `data/mock-drafts/<year>.json`, not served): the curve widened 40% toward
   the board prospects' shares, 75% of the outlook, 25% college model.
3. **Market-implied pick** (`model+market`): a market-listed player with no
   board or mock pick gets the pick his devy superflex price implies,
   log(pick) = a + b·log(price), fitted at build time on the board's class
   (players with both; currently about log pick = 15.9 − 1.53·log price, rank
   correlation with the board −0.57). A loose signal (the market prices
   fantasy value, not draft slot), so the curve is widened 50% and blended
   50/50 with the college model.
4. **College model alone** for everyone else. A QB in a later class with no
   pick source shows none: from college stats alone it misreads them
   (LaNorris Sellers 0% round 1).

Neither the mock's nor the market's weights are validated: there are no
archived early mocks or pre-2026-draft devy prices.

**Round 1 recalibrated by distance from the draft.** Held out, the college
model's top round-1 calls ran too sure, more so further out. Its round-1
chance now goes through a logistic in log-odds per distance (pooled over
positions; nested by class), which lowers held-out log loss at every distance
(one season out 0.0589 → 0.0558, three out 0.0818 → 0.0787). A line in
log-odds still left the very top too sure (one season out, the 20 highest
held-out calls averaged 73% and went round 1 55% of the time), so the chance
is also capped at the round-1 rate of the model's top 20 held-out calls at
that distance: 80% in the final season, 55% one season out, 40% two, 25%
three (`draftRound1Calibration` in `devy-model.json`). Out of sample on the
2023–2026 classes the model's round-1 AUC was 0.98 / 0.95 / 0.89 / 0.88 at
0–3 seasons out.

**Market history, for a real check.** There was no devy price history before
September 2026. `scripts/snapshot_devy_market.py` (weekly in the in-season
workflow; `--backfill` from git) keeps a copy of each week's devy market
prices in `data/devy-market-history/<date>.json` (an input, not served). After
the 2027 draft, `python3 scripts/validate_devy_market_round.py 2027` scores
every pre-draft snapshot against the actual rounds (AUC for round 1, rounds
1–3 and drafted, and the round-1 rate by price band, by months ahead) and
writes `data/devy-market-validation/2027.json`. That is the test the market
fallback is waiting on. For rookies after they declare, the market price
already separates round 1 cleanly: 2026 dynasty rookie prices two weeks before
the draft gave AUC 0.995 for round 1 (every rookie priced 4000+ went round 1,
80% of 3000–4000, none below 3000).

Results (superflex board, 2026-10-03): Manning, Dante Moore, Julian Sayin and
Jeremiah Smith round 1 87%; CJ Carr 79%; Mensah 49% (rounds 1–3: 88%);
Trinidad Chambliss 6% (56%). 2028: Keelon Russell 61% (mock), Bear Bachmeier
20% (market), LaNorris Sellers 8% (market). The board shows round 1 and rounds
1–3 rather than a most-likely day, which misled when the chances were spread
(Mensah's single largest day was Day 3 at 35% under the old blend).

The high-school board moved to hit % too: an unpenalized logistic in the rating
per position group. The default penalty had flattened the slope until
fold-to-fold intercepts decided the order, which also fixes `pDrafted`.

## Player cards

Click a name on the Devy page, or call `get_devy_player` in the MCP, to open a
player's card. It shows:

- **StatHead numbers:** composite, value-model price, career projection, dynasty value, estimated age and breakout age.
- **College season lines:** the last five seasons, plus the current season to date with games played.
- **The current season's game log:** week, date, opponent, home/away, result, and his passing, rushing and receiving line.

How it's built:

- `scripts/build_devy_cards.py` writes `public/data/devy-cards/<n>.json`, 64 shards keyed by `cfbdId % 64`, about 30 KB each. A card loads one shard.
- Inputs are the CFBD season files, the in-season season-to-date file, and `cfbd/inseason/player-games-<Y>.json.gz`.
- `scripts/fetch_cfbd_inseason.py` pulls game logs, one `/games/players` call per week. Weeks already on disk are kept, and the newest week is re-fetched to pick up stat corrections.
- Game logs cover the regular season only.
- `devy-inseason.yml` builds the cards weekly. It also runs when the fetcher or the card builder changes on the default branch. `fetch-cfbd-college.yml` builds them after each full-season fetch.
- Stats are facts, not rankings or values, so the third-party rule doesn't restrict them.

## Freshness and limits

- **In season, profiles run through the last completed week** (see "Season to
  date"). Otherwise they stop at the last complete college season, and the
  February run after each season retrains both models and re-scores everyone.
- **The draft class rolls over after the NFL draft** (May): that class leaves
  the devy list.
- **Undrafted free agents who made it** (an Austin Ekeler) count as 0 in the
  target, because the NFL outcome is joined through the draft. The model is a
  little pessimistic about the profiles that produce them.
- **The 2029 class is thin:** KTC lists one player. The 2026 recruiting class is
  in the pool now (the in-season fetch pulls it), but most freshmen have few or
  no college snaps, so few price high enough to make the board.
- **No KTC history.** The value model learns today's KTC cross-section. It's
  tested against NFL outcomes on past classes (see "Backtest"), not against
  past KTC prices.
- **Estimated ages.** A real birthdate source would sharpen the value model's
  age and breakout-age features, which the devy market prices heavily. The
  ESPN class is a floor: a sixth-year still reads as a senior (Chambliss, in
  college since 2021, reads as entering in 2023).
