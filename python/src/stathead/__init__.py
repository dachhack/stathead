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
from .features import load_feature_matrix, load_manual_overrides
from .predictions import load_career_backtest, load_career_predictions_2026
from .prospects import load_prospect_grades

__version__ = "0.2.1"

__all__ = [
    "__version__",
    "clear_cache",
    "pin_version",
    "set_ref",
    "load_adp_ffc",
    "load_adp_historical",
    "load_career_backtest",
    "load_career_predictions_2026",
    "load_feature_matrix",
    "load_manual_overrides",
    "load_player_crosswalk",
    "load_player_profile",
    "load_prospect_grades",
    "get_player",
    "resolve_player",
]
