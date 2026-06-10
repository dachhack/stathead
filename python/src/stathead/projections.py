"""Model projection outputs — the same numbers the web app's projection,
ADP-value, volume, and taxi-squad tabs render.

All of these are StatHead's own model outputs (scored from the feature
store), so there's no third-party redistribution concern. Each loader
stamps a canonical ``player_key`` where a name + position is available.
"""
from __future__ import annotations

import pandas as pd

from ._fetch import fetch_json
from .crosswalk import _norm, key_by_name_pos


def _stamp_keys(df: pd.DataFrame, name_col: str = "name",
                pos_col: str = "position") -> pd.DataFrame:
    """Add a leading ``player_key`` column resolved from (name, position)."""
    if name_col not in df.columns or pos_col not in df.columns:
        return df
    keymap = key_by_name_pos()
    keys = [
        keymap.get((_norm(str(n)), str(p)))
        for n, p in zip(df[name_col], df[pos_col])
    ]
    df.insert(0, "player_key", keys)
    return df


def load_redraft_projections() -> pd.DataFrame:
    """Seasonal redraft projections — projected PPG (PPR) + receptions/game.

    Veterans blend prior-season actuals, a 2-year average, and an age curve;
    rookies use the career model's best-2-of-3 PPG with a per-position,
    pick-based Year-1 discount. ``recPG`` (receptions/game) supports TE-premium
    scoring.

    Columns: ``player_key``, ``name``, ``position``, ``ppg``, ``recPG``,
    ``season``, ``scoring``.
    """
    data = fetch_json("public/data/redraft-projections.json")
    df = pd.DataFrame(data.get("players") or [])
    df["season"] = data.get("season")
    df["scoring"] = data.get("scoring")
    return _stamp_keys(df)


def load_ppg_projections() -> pd.DataFrame:
    """Model-predicted points-per-game for established players.

    Columns: ``player_key``, ``name``, ``position``, ``predictedPPG``.
    """
    df = pd.DataFrame(fetch_json("public/data/score-store/ppg.json"))
    return _stamp_keys(df)


def load_adp_value_model() -> pd.DataFrame:
    """ADP value model — predicted value-over-replacement vs market ADP,
    with a calibrated hit probability and confidence interval.

    Columns: ``player_key``, ``name``, ``position``, ``team``, ``adp``,
    ``predictedVor``, ``hitProb`` (label), ``ciLower``, ``ciUpper``,
    ``isRookie``.
    """
    df = pd.DataFrame(fetch_json("public/data/score-store/adp.json"))
    df = df.drop(columns=[c for c in ("headshotUrl",) if c in df.columns])
    return _stamp_keys(df)


def load_volume_projections() -> pd.DataFrame:
    """Team + player volume projections with low/high bands.

    Columns: ``player_key``, ``name``, ``position``, ``team``,
    ``teamPassAtt`` (+ ``Low`` / ``High``), ``teamRushAtt`` (+ bands),
    ``teamTargets`` (+ bands), ``projPlayerPPG``.
    """
    df = pd.DataFrame(fetch_json("public/data/score-store/volumes.json"))
    return _stamp_keys(df)


def load_share_projections() -> pd.DataFrame:
    """Predicted target share + rush share for each player.

    Columns: ``player_key``, ``name``, ``position``, ``team``,
    ``predTargetShare``, ``predRushShare``.
    """
    df = pd.DataFrame(fetch_json("public/data/score-store/shares.json"))
    return _stamp_keys(df)


def load_taxi_predictions() -> pd.DataFrame:
    """Taxi-squad model — probability a young player makes / sticks on a
    fantasy roster.

    Columns: ``player_key``, ``name``, ``position``, ``p1`` (year-1 roster
    probability), ``p2`` (year-2), ``pEver`` (ever rostered). Model metadata
    (training date, thresholds, LOSO AUC) is attached on
    ``df.attrs['meta']``.
    """
    data = fetch_json("public/data/score-store/taxi.json")
    df = pd.DataFrame(data.get("players") or [])
    df = _stamp_keys(df)
    df.attrs["meta"] = data.get("meta") or {}
    return df


def load_career_2027() -> pd.DataFrame:
    """2027 draft-class early prospect board — grades + college aggregates.

    The next class after :func:`~stathead.load_prospect_grades`. Columns
    include ``name``, ``pos``, ``school``, ``grade``, ``projPick``,
    ``projRound``, ``tier``, plus college career box-score totals
    (``careerPassYds``, ``careerRushYds``, ``careerRecYds``, …).
    """
    df = pd.DataFrame(fetch_json("public/data/career-2027.json"))
    return _stamp_keys(df, pos_col="pos")
