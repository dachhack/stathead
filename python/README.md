# stathead

Python client for the [StatHead](https://github.com/dachhack/stathead) fantasy football model. Returns pandas DataFrames of rookie career predictions, historical ADP, and the flattened feature matrix used to train the models.

## Install

```bash
pip install stathead
```

Optional extras:

```bash
pip install "stathead[polars]"   # for .to_polars() helpers
pip install "stathead[duckdb]"   # for local SQL querying
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

| Function | Returns | Shape |
|---|---|---|
| `load_career_predictions_2026()` | 2026 rookie predictions | ~77 × ~80 cols |
| `load_career_backtest()` | Historical rookies with pred + actual PPG | ~1087 × ~100 cols |
| `load_adp_historical()` | Model-training ADP 2010-2025 | 4507 × 10 |
| `load_adp_ffc(season=None)` | FFC PPR raw ADP (per season as fetched) — data via [Fantasy Football Calculator](https://fantasyfootballcalculator.com/adp/ppr) | variable |
| `load_prospect_grades(year=2026)` | Scouting-report grades | ~200 × 7 |
| `load_feature_matrix()` | Raw `feature-matrix.json` (dict) | — |
| `load_manual_overrides()` | Manual CFBD usage overrides (dict) | — |

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
