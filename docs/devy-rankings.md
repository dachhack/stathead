# Devy rankings (2026-09-30)

Devy rankings and values for college QB/RB/WR/TE in the next three draft
classes. They combine KTC's devy market with our own college-profile model,
and they're priced on the dynasty scale, so a college player can be weighed
against NFL players and rookie picks.

- Site: the **Devy** tab (Dynasty group).
- MCP: `get_devy_rankings`.
- Data: `public/data/devy-rankings.json`.

## Pipeline

| step | script | runs |
|---|---|---|
| KTC devy market (SF + 1QB values, draft year, school) | `scripts/fetch-ktc.cjs` → `ktc_rankings_devy.json` | daily, `fetch-ktc-snapshot.yml` |
| College-profile model, trained and scored | `scripts/train_devy_model.py` → `devy-model.json`, `devy-model-scores.json` | monthly with new CFBD data, `fetch-cfbd-college.yml` |
| Blend and dynasty pricing | `scripts/build-devy-rankings.py` → `devy-rankings.json` | daily after the KTC fetch, and after a retrain |

Features are computed in `scripts/devy_features.py`, shared by the training
and scoring code.

## The model

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
| QB | 0.28 / 4.7 | 0.05 / 2.9 | **0.31 / 4.8** |
| RB | **0.37 / 5.3** | 0.15 / 3.8 | 0.34 / 4.2 |
| WR | **0.41 / 5.5** | 0.13 / 3.3 | 0.36 / 4.1 |
| TE | 0.46 / 6.5 | −0.09 / 3.8 | 0.47 / 6.8 |

- **Two or more years out (k = 2–3):** the model beats both baselines at every
  position. That's where devy value is made, and where last-season production
  alone stops working (Spearman near 0 at k=3).
- **Final seasons:** it roughly ties production.
- **QB:** it trails production.

Full metrics are in `devy-model.json`.

## The blend

Computed per format (SF, 1QB):

1. **Market:** z-score of log(KTC devy value) across the devy list.
2. **Model:** a rank-based normal score of the model within the position, so it
   reorders players within a position and never overrides the market's
   QB-vs-WR pricing.
3. **Blend:** `(1 − w) × market + w × model`, with w = 0.25, or 0.15 at QB.
   With a Spearman around 0.3–0.45 the model should nudge the market's order,
   not rewrite it. The median move is 6 places, and the largest are about 30
   in both directions (Dierre Hill KTC #61 → #30; Raleek Brown #39 → #70).
4. **Players KTC doesn't list** (source `model`, up to 15 per class) must have a
   known high-school class, which dates their draft eligibility. They enter at
   the market floor for their class and position: the lowest KTC value there,
   minus one market SD. The model can pull them onto the list but not to its
   top.
5. **Values:** players are sorted by the blend and assigned KTC's own sorted
   values. The market's value curve stays; only the order is ours.

## Dynasty scale

Within each class, a player's blended rank is his expected rookie-draft slot:
with 12 teams, 1–4 Early 1st, 5–8 Mid, 9–12 Late, and so on. That slot is
priced from KTC's future pick values for that year and format, interpolated
between tiers.

- The 1.01 and 1.02 extend the Early-to-Mid slope, capped at +25% of the
  Early-tier price, because a near-certain 1.01 is worth more than an average
  Early 1st.
- A 2028 player is priced as a 2028 pick, which KTC discounts against 2027.
  So Bo Jackson (2028, devy #3) is worth 5,556 on the dynasty scale, while
  Arch Manning (2027, #4) is worth 7,254.

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
- **KTC lists about 100 devy players**, and only 1 in the 2029 class. That
  class is mostly model-only additions (16 players in all), so it's the least
  market-anchored.
- **Weights are judgment calls.** There's no history of KTC devy values to fit
  them against.
