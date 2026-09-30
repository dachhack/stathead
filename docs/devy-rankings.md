# Devy rankings (2026-09-30)

Devy rankings for college QB/RB/WR/TE in the next three draft classes. The
headline is a **composite** of two scores per player (see "Composite" below):

- **Devy value:** the market's price on KTC's 0–9999 devy scale. For the ~100
  players KTC lists it's KTC's own value; for everyone else it comes from our
  devy value model, which learns KTC's pricing from college profiles.
- **Career score:** our NFL projection from the college profile.

Both scores, every rank and the dynasty value exist separately for
**superflex / 2QB** (`sf`) and **single QB** (`oneQB`). Switching format
switches all of them:
- KTC's own superflex and 1QB prices;
- the value model, which is trained on each separately;
- the QB replacement level in the career score;
- KTC's superflex and 1QB future pick values.

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
  at the end of its first college season. Redshirts and reclassified players
  are off by up to a year.
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
the market's taste, not the truth. It also can't see what KTC pays for QB
pedigree beyond the stats. Arch Manning's profile prices at 5,666 in superflex
against his KTC 7,107; the draft-board features closed some of that gap, from
3,489. For a listed player, the board shows the model's price next to
KTC's as a check, never as a replacement.

## Career model

**Question:** what does a college player's profile say about his NFL fantasy
future, 0–3 seasons before he's draft eligible?

**Target:** the mean of his best two PPR points-per-game seasons (6+ games)
in his first four NFL seasons. A missing season counts as 0, and so does a
player who was never drafted. The target therefore prices both the chance he
makes it and how good he is if he does.

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

## The board

- **Players:** everyone KTC lists (100) plus every other current college player
  the value model prices at 40 or more in either format (96 today). The
  on-disk scores keep everyone priced at 5 or more.
- **Order:** by composite, per format. The market rank is kept alongside it.
- **Career score:** above replacement in that format, with its rank and
  percentile over the whole board. The raw PPG projection is shown next to it.
- **careerVsValue:** overall devy-value rank minus overall career rank in that
  format. Positive means the projection likes him more than the market does.
- **Example:** Arch Manning is #3 by devy value in superflex, with career rank
  #69; in 1QB he's #7 and #123.

## Composite

The composite blends the market and our projection, then prices the result on
the market's own scale:

1. **Market z:** the z-score of log devy value over the board.
2. **Career z:** the normal score of his career-score rank over the board. Raw
   PPG breaks ties among the many players at 0 above replacement.
3. **Blend:** composite = (1 − w) × market z + w × career z.
4. **Price:** sort by the blend and hand out the market's own sorted values,
   so `compositeValue` stays on KTC's 0–9999 scale and the top of the board
   costs what the market's top costs.

**The weight w is the career model's own held-out skill** at the player's
position and distance from the draft (k = seasons until his draft year):
0.75 × its Spearman, halved where it doesn't beat last-season production,
clamped to 0.05–0.35. The build reads it from `devy-model.json`, so it updates
with each retrain. Today:

| Position | k=1 (2027 class) | k=2 (2028) | k=3 (2029) |
|---|---|---|---|
| QB | 0.11 | 0.17 | 0.15 |
| RB | 0.30 | 0.28 | 0.25 |
| WR | 0.32 | 0.26 | 0.22 |
| TE | 0.17 | 0.25 | 0.22 |

The market always leads, and QBs move least because the QB career model is the
weakest (k=2 Spearman 0.23). A first cut with a flat 0.35 weight two or more
seasons out dropped LaNorris Sellers from #25 to #103 on a model with that
little skill. The skill-based weight holds him at #74.

**How far it moves the board (today):**

| Format | Median move | Max move | Top-50 overlap with market |
|---|---|---|---|
| Superflex / 2QB | 10 | 56 | 40 |
| 1QB | 11 | 64 | 38 |

Examples (superflex, market → composite):

- **Up:** Ryan Coleman-Williams 15 → 2 (career #2), Dierre Hill Jr. 61 → 23,
  Byrum Brown 59 → 26, Bo Jackson 12 → 5.
- **Down:** Kewan Lacy 5 → 42 (career #165: 6.2 PPG, at replacement),
  Isaac Brown 17 → 67, Sellers 25 → 74, Arch Manning 3 → 7.

Fields: `compositeValue`, `compositeRank`, `compositePosRank` and
`compositeWeight` (per format). `rank` / `posRank` stay the market ranks, and
`careerVsValue` still sets market rank against career rank.

## Dynasty scale

Within each class, a player's composite rank is his expected rookie-draft slot:
with 12 teams, 1–4 Early 1st, 5–8 Mid, 9–12 Late, and so on. That slot is
priced from KTC's future pick values for that year and format, interpolated
between tiers.

- The 1.01 and 1.02 extend the Early-to-Mid slope, capped at +25% of the
  Early-tier price, because a near-certain 1.01 is worth more than an average
  Early 1st.
- A 2028 player is priced as a 2028 pick, which KTC discounts against 2027.
  So Bo Jackson (2028, class #2) is worth 5,548 on the dynasty scale, while
  Ryan Coleman-Williams (2027, class #2) is worth 7,222.
- `dynastyMarket` is the same pricing from the market class rank alone (Arch
  Manning: 7,222 by market, 6,599 by composite).
- **Class depth on the board isn't the true class depth.** The value model
  prices a 2027 upperclassman with production above an unproven 2028 player, so
  a 2027 player 50th in his class ("beyond round 4") can be worth less on the
  dynasty scale than a 2028 player 40th in his.

## Freshness and limits

- **Model features stop at the last complete college season** (2025 until
  February 2027). In-season 2026 stats aren't used: the CFBD cache stores a
  year once, so an in-season pull would stick, and the model was trained on
  whole seasons. `fetch_cfbd_college_stats.py` defaults to complete seasons
  only, and the February run after each season retrains the model and
  re-scores everyone.
- **The draft class rolls over after the NFL draft** (May): that class leaves
  the devy list.
- **Undrafted free agents who made it** (an Austin Ekeler) count as 0 in the
  target, because the NFL outcome is joined through the draft. The model is a
  little pessimistic about the profiles that produce them.
- **The 2029 class is thin:** KTC lists one player, and the value model only
  prices players whose profiles run through 2025. The 2026 recruiting class
  joins in February 2027.
- **No KTC history.** The value model learns today's KTC cross-section; there's
  no history of devy values to test it over time.
- **Estimated ages.** A real birthdate source would sharpen the value model's
  age and breakout-age features, which the devy market prices heavily.
