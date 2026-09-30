# Devy rankings (2026-09-30)

Devy rankings for college QB/RB/WR/TE in the next three draft classes, with
two scores per player:

- **Devy value:** the market's price on KTC's 0–9999 devy scale. For the ~100
  players KTC lists it's KTC's own value; for everyone else it comes from our
  devy value model, which learns KTC's pricing from college profiles.
- **Career score:** our NFL projection from the college profile.

The board is ordered by devy value and also priced on the dynasty scale, so a
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
| Board: two scores, ranks and dynasty pricing | `scripts/build-devy-rankings.py` → `devy-rankings.json` | daily after the KTC fetch, and after a retrain |

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
- **Recruiting and body:** rating, stars, height, weight.
- **Position.**

**Validation** (5-fold CV; players and folds sorted and LightGBM seeded, so
every run is identical):

| | superflex | 1QB |
|---|---|---|
| Value-if-listed Spearman with KTC, held out (ridge) | **0.67** | **0.66** |
| Same, recruit rating alone | 0.02 | 0.04 |
| R² of log value | 0.36 | 0.23 |
| Median error | ×1.5 | ×1.4 |
| P(listed) AUC, listed vs unlisted FBS players | 0.96 | |

**What drives it:**
- **Being listed:** recruit rating, program talent and SP+, usage rate,
  touchdowns, power conference.
- **Price once listed:** program talent, receiving TDs and receptions,
  dominator, and an earlier breakout age. Interceptions count against QBs, and
  TEs are discounted.

**What it can't see.** It learns the market's cross-section, so it inherits
the market's taste, not the truth. It also can't see what KTC pays for QB
pedigree beyond the stats. Arch Manning's profile prices at 3,489 against his
KTC 7,107. For a listed player, the board shows the model's price next to
KTC's as a check, never as a replacement.

## Career model

**Question:** what does a college player's profile say about his NFL fantasy
future, 0–3 seasons before he's draft eligible?

**Target:** the mean of his best two PPR points-per-game seasons (6+ games)
in his first four NFL seasons. A missing season counts as 0, and so does a
player who was never drafted. The target therefore prices both the chance he
makes it and how good he is if he does.

**History:**
- Every CFBD QB/RB/WR/TE from 2005 on who was a 3-star+ recruit, was drafted,
  or produced (500+ scrimmage or 1,500+ passing yards in a season).
- Draft classes 2010–2022, which have four NFL seasons to measure.
- One row per player per snapshot k = seasons left before the draft (0–3).
  Each row's features use only seasons up to that point.
- 17,959 snapshots of 4,930 players, 925 of them drafted.

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

The model is LightGBM, one per position, with k as a feature.

**Validation:** leave one draft class out at a time. Scored by Spearman
correlation with the outcome within each (class, k), and how many of each
class's actual top 12 the top 12 by each score catch:

| k=1 (e.g. the 2027 class now) | model | recruit rating | last-season production |
|---|---|---|---|
| QB | 0.27 / 4.5 | 0.05 / 2.9 | **0.31 / 4.8** |
| RB | **0.38 / 5.5** | 0.15 / 3.8 | 0.34 / 4.2 |
| WR | **0.40 / 5.5** | 0.13 / 3.3 | 0.36 / 4.1 |
| TE | 0.47 / 6.7 | −0.09 / 3.8 | 0.47 / 6.8 |

- **Two or more years out (k = 2–3):** the model beats both baselines at every
  position. That's where devy value is made, and where last-season production
  alone stops working (Spearman near 0 at k=3).
- **Final seasons:** it roughly ties production.
- **QB:** it trails production.

Full metrics are in `devy-model.json`.

## The board

- **Players:** everyone KTC lists (100) plus every other current college player
  the value model prices at 40 or more in either format (119 today; 94 in the
  2027 class and 25 in 2028). The on-disk scores keep everyone priced at 5 or
  more.
- **Order:** by devy value, per format.
- **Career score** is shown next to it, with its percentile in the position on
  the board.
- **careerVsValue** = position rank by devy value minus position rank by career
  score. Positive means the projection likes him more than the market does.
  - Liked more than the market: Diego Pavia (Vanderbilt QB, value 781, career
    94th percentile, +25) and Mario Craver (Texas A&M WR, 323, 92nd, +27).
  - Liked less: Hollywood Smothers (KTC 3,038, 20th percentile, −41).

## Dynasty scale

Within each class, a player's devy-value rank is his expected rookie-draft slot:
with 12 teams, 1–4 Early 1st, 5–8 Mid, 9–12 Late, and so on. That slot is
priced from KTC's future pick values for that year and format, interpolated
between tiers.

- The 1.01 and 1.02 extend the Early-to-Mid slope, capped at +25% of the
  Early-tier price, because a near-certain 1.01 is worth more than an average
  Early 1st.
- A 2028 player is priced as a 2028 pick, which KTC discounts against 2027.
  So Bo Jackson (2028, class #2) is worth 5,548 on the dynasty scale, while
  Arch Manning (2027, class #2) is worth 7,222.
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
