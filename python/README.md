# stathead

Python client for the [StatHead](https://github.com/dachhack/stathead) fantasy football model. Returns pandas DataFrames of rookie career predictions, historical ADP, and the flattened feature matrix used to train the models.

## Install

```bash
pip install stathead
```

Optional extras:

```bash
pip install "stathead[polars]"   # for sh.to_polars() / sh.load_polars() helpers
pip install "stathead[duckdb]"   # for local SQL querying (sh.query)
```

## Quick start

```python
import stathead as sh

# 2026 rookie class predictions (77 players × ~80 columns)
rookies = sh.load_career_predictions_2026()
rookies.nlargest(10, "percentile")[["name", "position", "predictedCareerPPG", "modelTier"]]

# Historical backtest — predicted vs actual for every drafted rookie 2010-2025
backtest = sh.load_career_backtest()
wr = backtest[backtest.position == "WR"]
wr.groupby("modelTier")[["actualPPG", "predictedPPG"]].mean()

# Historical ADP, every season fully populated
adp = sh.load_adp_historical()
adp[(adp.season == 2023) & (adp.adp <= 24)]
```

## SQL querying

With the `duckdb` extra, `sh.query()` runs SQL over the loaders — the same
surface as the site's Data Query tab, in Python. Every table joins on
`player_key`.

```bash
pip install "stathead[duckdb]"
```

```python
import stathead as sh

sh.query("""
    SELECT c.name, c.position, c.predictedCareerPPG, d.value_1qb
    FROM career_2026 c
    JOIN dynasty_values d USING (player_key)
    WHERE c.percentile >= 80
    ORDER BY d.value_1qb DESC
""")

sh.list_tables()   # every queryable table name
```

Tables load lazily — only the ones a query references are materialized, so a
query that never touches `player_stats` (~400k rows) doesn't pay for it.
Register your own DataFrame (a roster, a league export) to join against the
model tables:

```python
sh.register("my_roster", roster_df)
sh.query("SELECT * FROM career_2026 c JOIN my_roster r USING (player_key)")
```

## Polars

Loaders return pandas. With the `polars` extra, convert any of them — handy on
the big tables like `load_player_stats` (~400k rows) where polars is faster.

```bash
pip install "stathead[polars]"
```

```python
import stathead as sh

pl_df = sh.to_polars(sh.load_player_stats(2024))

# Or convert a loader by reference, without calling it yourself:
pl_df = sh.load_polars(sh.load_player_stats, 2024)
```

## Pinning to a specific version

Loaders resolve against the upstream GitHub repo. Pin to a commit SHA, tag,
or branch for reproducibility:

```python
sh.pin_version("a6720e5")   # or a tagged release
```

Clear the local cache if you want to re-fetch:

```python
sh.clear_cache()
```

## Data freshness

Data files are cached under `~/.cache/stathead/<ref>/` after the first
download. Subsequent runs read from disk — no network roundtrip. Delete the
cache directory or call `clear_cache()` to force a refresh.

## Available loaders

Every table on the [StatHead site](https://github.com/dachhack/stathead) is
available here as a pandas DataFrame.

**Predictions & prospects**

| Function | Returns | Shape |
|---|---|---|
| `load_career_predictions_2026()` | 2026 rookie predictions | ~77 × ~80 cols |
| `load_career_backtest()` | Historical rookies with pred + actual PPG | ~1087 × ~100 cols |
| `load_prospect_grades(year=2026)` | Scouting-report grades | ~200 × 7 |
| `load_career_2027()` | 2027 draft-class early board + college aggregates | ~200 × ~30 |

**Projections (model outputs)**

| Function | Returns | Shape |
|---|---|---|
| `load_redraft_projections()` | Seasonal redraft PPG (PPR) + receptions/game | ~250 × 7 |
| `load_weekly_projections()` | Per-week matchup-adjusted projections incl. kickers + team DST, one row per player-game (opp, home, matchup mult, PPR pts, gsis/sleeper ids; `df.attrs['def_vs_pos']`) | ~509 × 17 rows/player |
| `load_player_props()` | Per-week projected **stat lines** (att/comp/yds/TD/tgt/rec), one row per player-game, with opponent, availability and defense grades (`df.attrs['dispersion']`, `['defense']`, `['bye_weeks']`) | ~445 × 17 rows/player |
| `price_props(player, week)` | Every prop for one player-week: mean, half-point line, over/under, p10–p90 (`df.attrs['anytime_td']`) | ~8 × 7 |
| `rest_of_game(player, week, quarter, score_diff=…, so_far=…)` | What's still to come after Q1 / halftime / Q3, adjusted for game script and in-game pace | ~7 × 12 |
| `load_quarter_splits()` / `quarter_share_frame()` | Quarter shares, game-script multipliers, blend weights and partial-window spread from play-by-play | dict / ~28 × 10 |
| `load_inseason_projections(season)` | Walk-forward game-by-game projections — week *w* from weeks 1..w-1 only | ~6,000 × ~14 |
| `load_weekly_backtest(season)` / `backtest_frame()` | How that model scored vs actuals, naive baselines and an external projection | dict / ~30 × 10 |
| `load_ppg_projections()` | Model-predicted PPG for established players | ~250 × 4 |
| `load_adp_value_model()` | VOR vs ADP, hit probability, confidence interval | ~153 × 10 |
| `load_volume_projections()` | Team pass/rush/target volumes with low/high bands | ~153 × ~14 |
| `load_share_projections()` | Predicted target + rush share | ~153 × 6 |
| `load_taxi_predictions()` | Taxi-squad roster/drop probabilities (+ `df.attrs['meta']`) | ~96 × 6 |

**Market & stats**

| Function | Returns | Shape |
|---|---|---|
| `load_player_stats(season=None)` | Per-player per-week NFL box scores 2010-present | ~400k × ~50 |
| `load_dynasty_values()` | In-house blended dynasty value (1QB + Superflex) | ~500 × 10 |
| `load_dynasty_value_history()` | Blended daily dynasty value history | variable |
| `load_adp_historical()` | Model-training ADP 2010-2025 | 4507 × 10 |
| `load_adp_ffc(season=None)` | FFC PPR raw ADP (per season as fetched) — data via [Fantasy Football Calculator](https://fantasyfootballcalculator.com/adp/ppr) | variable |

**Identity & raw**

| Function | Returns | Shape |
|---|---|---|
| `load_player_crosswalk()` | Canonical cross-source player IDs | ~10k × ~20 |
| `resolve_player(name, position=None)` / `get_player(key)` / `load_player_profile(key)` | Name → `player_key` helpers | — |
| `load_feature_matrix()` | Raw `feature-matrix.json` (dict) | — |
| `load_manual_overrides()` | Manual CFBD usage overrides (dict) | — |

Every row-shaped loader carries a `player_key` column that joins to
`load_player_crosswalk()`.

### Dynasty values are the app's in-house blend

`load_dynasty_values()` returns the same blended value the web app displays:
KTC rankings rescaled into FantasyCalc's scale via a per-player ratio
(`fc_value / ktc_value`, with a positional-median fallback below a value
floor). The ratio snapshot is built offline and committed as
`public/data/dynasty-fc-rescale.json`; the loader just applies it. No raw KTC
value is exposed — only the rescaled blend.

## Feature columns

Career-prediction and backtest rows include flattened model features
under names like `collegeDominatorRating`, `relativeAthleticScore`,
`recruitRating`, `nflDraftPick`, plus two source-agnostic families
aggregated from the project's scouting-report pipeline:

- **`scout*`** — single-scout grade signals (e.g. `scoutGradeDraft`,
  `scoutTierOrdinal`, `scoutBreadthDraft`, `scoutNComps`).
- **`guide*`** — multi-source draft-guide aggregations
  (`guideRankMean`, `guideRankSpread`, `guideNStrengths`,
  `guideNWeaknesses`, `guideSentimentNet`, …).

Both families are derived numeric features (counts, means, ordinals) —
no verbatim scouting-report text is shipped. `hasScoutGrade` /
`hasGuideData` flag missing-data so models can distinguish
"no scout coverage" from "low score".

## Licensing & attribution

Package code is MIT-licensed. The data this package retrieves is derived
from the StatHead project's own modeling pipeline; upstream sources
(nflverse, FFC, CFBD, etc.) retain their own terms — see each source's
license before redistributing. Sources whose terms do not permit
third-party redistribution (e.g. KeepTradeCut dynasty values, verbatim
prose from paid scouting reports) are intentionally not exposed by
this client.

ADP data exposed by `load_adp_ffc` is courtesy of
[Fantasy Football Calculator](https://fantasyfootballcalculator.com/) — please
preserve attribution when redistributing.

If you're building on these predictions, a link back to the StatHead repo
is appreciated but not required.

## Contributing

The package is small and focused — see
[`python/src/stathead/`](./src/stathead/) for the loader modules. Issues
and PRs welcome at the [main repo](https://github.com/dachhack/stathead).
