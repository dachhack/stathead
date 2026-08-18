"""StatHead — Python client for the fantasy football model.

Loaders return pandas DataFrames sourced from the upstream repo at
https://github.com/dachhack/stathead. First call downloads + caches the
underlying JSON/CSV; subsequent calls read from the cache.

Quick start:

    import stathead as sh

    rookies = sh.load_career_predictions_2026()
    backtest = sh.load_career_backtest()
    adp = sh.load_adp_historical()

Pin to a specific commit for reproducibility:

    sh.pin_version("a6720e5")  # or any git ref/tag/SHA
"""
from ._fetch import clear_cache, pin_version, set_ref
from .adp import load_adp_ffc, load_adp_historical
from .crosswalk import (
    get_player,
    load_player_crosswalk,
    load_player_profile,
    resolve_player,
)
from .dynasty import load_dynasty_value_history, load_dynasty_values
from .features import load_feature_matrix, load_manual_overrides
from .predictions import load_career_backtest, load_career_predictions_2026
from .projections import (
    load_adp_value_model,
    load_career_2027,
    load_ppg_projections,
    load_redraft_projections,
    load_share_projections,
    load_taxi_predictions,
    load_volume_projections,
    load_weekly_projections,
)
from .polars import load_polars, to_polars
from .props import (
    anytime_td_prob,
    backtest_frame,
    load_inseason_projections,
    load_player_props,
    load_quarter_splits,
    load_weekly_backtest,
    price_prop,
    price_props,
    quarter_share_frame,
    rest_of_game,
)
from .prospects import load_prospect_grades
from .sql import list_tables, query, register
from .stats import load_player_stats

__version__ = "0.5.0"

__all__ = [
    "__version__",
    "clear_cache",
    "pin_version",
    "set_ref",
    "load_adp_ffc",
    "load_adp_historical",
    "load_adp_value_model",
    "load_career_2027",
    "load_career_backtest",
    "load_career_predictions_2026",
    "load_dynasty_value_history",
    "load_dynasty_values",
    "load_feature_matrix",
    "load_manual_overrides",
    "load_player_crosswalk",
    "load_inseason_projections",
    "load_player_props",
    "load_quarter_splits",
    "load_weekly_backtest",
    "load_player_profile",
    "load_player_stats",
    "load_ppg_projections",
    "load_prospect_grades",
    "load_redraft_projections",
    "load_share_projections",
    "load_taxi_predictions",
    "load_volume_projections",
    "load_weekly_projections",
    "anytime_td_prob",
    "backtest_frame",
    "price_prop",
    "price_props",
    "quarter_share_frame",
    "rest_of_game",
    "get_player",
    "resolve_player",
    "query",
    "register",
    "list_tables",
    "to_polars",
    "load_polars",
]
