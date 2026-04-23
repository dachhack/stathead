"""Unified player identity — the canonical cross-source ID for every table.

Every other loader in this package includes a ``player_key`` column that
joins against :func:`load_player_crosswalk`. Format is ``sh_<10 hex>``
derived from a stable identity tuple (GSIS ID for NFL players, or
``COL:<name>:<position>:<draft_class>`` for pre-draft college prospects).
Built by ``scripts/build-player-crosswalk.py`` in the repo.
"""
from __future__ import annotations

import pandas as pd

from ._fetch import fetch_json


def load_player_crosswalk() -> pd.DataFrame:
    """One row per canonical player with every known ID.

    Columns include ``player_key`` (canonical), ``display_name``,
    ``position``, ``birth_date``, ``college``, ``gsis_id``, ``pfr_id``,
    ``sleeper_id``, ``espn_id``, ``pff_id``, ``yahoo_id``,
    ``sportradar_id``, ``fantasy_data_id``, ``ktc_id``, ``draft_class``,
    ``earliest_season``, ``latest_season``, ``is_college_only``.

    Join any other loader (career backtest, ADP, KTC, player_stats) on
    ``player_key`` for unambiguous cross-table analysis.
    """
    raw = fetch_json("public/data/player-crosswalk.json")
    rows = [{k: v for k, v in rec.items() if k != "aliases"}
            for rec in raw.get("players") or []]
    df = pd.DataFrame(rows)
    # Consistent column order
    front = [c for c in [
        "player_key", "display_name", "position", "birth_date", "college",
        "gsis_id", "pfr_id", "sleeper_id", "espn_id", "pff_id", "yahoo_id",
        "sportradar_id", "rotowire_id", "fantasy_data_id", "ktc_id",
        "draft_class", "is_college_only", "earliest_season", "latest_season",
    ] if c in df.columns]
    rest = [c for c in df.columns if c not in front]
    return df[front + rest]
