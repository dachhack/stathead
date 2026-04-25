"""ADP loaders — historical (all seasons, model training data) + FFC raw."""
from __future__ import annotations

import pandas as pd

from ._fetch import fetch_json


def load_adp_historical() -> pd.DataFrame:
    """Historical ADP used in model training, fully populated 2010-2025.

    Sourced from the feature-store profile + players shards (already
    normalized across sources — this is the ADP the model actually trains
    on, not a single vendor's raw response).

    Columns: ``season``, ``name``, ``name_norm``, ``position``, ``adp``,
    ``adpRound``, ``nflDraftPick``, ``nflDraftRound``, ``age``,
    ``yearsInLeague``.

    Use this for any cross-year ADP analysis — it has no gaps.
    """
    profile = fetch_json("public/data/feature-store/profile.json")
    players = fetch_json("public/data/feature-store/players.json")
    rows: list[dict] = []
    for key, rec in profile.items():
        if "::" not in key:
            continue
        name_norm, season_str = key.rsplit("::", 1)
        try:
            season = int(season_str)
        except ValueError:
            continue
        info = players.get(key) or {}
        rows.append({
            "season": season,
            "name": info.get("displayName", name_norm),
            "name_norm": name_norm,
            "position": info.get("position"),
            "adp": rec.get("adp"),
            "adpRound": rec.get("adpRound"),
            "nflDraftPick": rec.get("nflDraftPick"),
            "nflDraftRound": rec.get("nflDraftRound"),
            "age": rec.get("age"),
            "yearsInLeague": rec.get("yearsInLeague"),
        })
    return pd.DataFrame(rows).sort_values(["season", "adp"], na_position="last").reset_index(drop=True)


def load_adp_ffc(season: int | None = None) -> pd.DataFrame:
    """FantasyFootballCalculator PPR ADP — raw API responses.

    Coverage depends on what has been fetched into the repo (currently 2025).
    Pass a ``season`` to filter, or leave ``None`` to load everything available.

    Columns: ``season``, ``name``, ``position``, ``team``, ``adp``, ``high``,
    ``low``, ``stdev``, ``timesDrafted``, ``bye``.

    Data courtesy of Fantasy Football Calculator
    (https://fantasyfootballcalculator.com/) — please preserve attribution
    when redistributing.
    """
    seasons = [season] if season else [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]
    rows: list[dict] = []
    for s in seasons:
        try:
            d = fetch_json(f"public/data/ffc_adp_ppr_{s}.json")
        except Exception:
            continue
        for p in d.get("players") or []:
            rows.append({"season": s, **p})
    return pd.DataFrame(rows)
