"""KeepTradeCut dynasty values — current snapshot + daily history."""
from __future__ import annotations

import pandas as pd

from ._fetch import fetch_json


def load_ktc() -> pd.DataFrame:
    """Current KTC dynasty values, one row per player.

    The 1QB rankings file carries both the ``value`` (1QB) and
    ``superflexValue`` in the same record, so a single fetch gives both
    formats.

    Columns: ``playerID``, ``name``, ``position``, ``positionRank``, ``team``,
    ``age``, ``value_1qb``, ``value_superflex``, ``isRookie``.
    """
    raw = fetch_json("public/data/ktc_rankings_1qb.json")
    rows = [{
        "playerID": r["playerID"],
        "name": r["playerName"],
        "position": r["position"],
        "positionRank": r.get("positionRank"),
        "team": r.get("team"),
        "age": r.get("age"),
        "value_1qb": r.get("value"),
        "value_superflex": r.get("superflexValue"),
        "isRookie": r.get("isRookie", False),
    } for r in raw]
    return pd.DataFrame(rows)


def load_ktc_history() -> pd.DataFrame:
    """Daily KTC value history — one row per (playerID, date).

    1QB and Superflex values are emitted side-by-side to make trend /
    momentum queries easy. ~100k rows (200+ days × 500 players).

    Columns: ``playerID``, ``name``, ``position``, ``team``, ``date``,
    ``value_1qb``, ``value_superflex``.
    """
    current = fetch_json("public/data/ktc_rankings_1qb.json")
    info_by_id = {r["playerID"]: {
        "name": r["playerName"], "position": r["position"], "team": r.get("team"),
    } for r in current}

    history = fetch_json("public/data/ktc_history.json")
    rows: list[dict] = []
    for h in history:
        info = info_by_id.get(h["playerID"], {})
        sf_map = {p["d"]: p["v"] for p in (h.get("superflex") or {}).get("valueHistory") or []}
        for p in (h.get("oneQB") or {}).get("valueHistory") or []:
            rows.append({
                "playerID": h["playerID"],
                "name": info.get("name"),
                "position": info.get("position"),
                "team": info.get("team"),
                "date": p["d"],
                "value_1qb": p["v"],
                "value_superflex": sf_map.get(p["d"]),
            })
    df = pd.DataFrame(rows)
    if not df.empty:
        df["date"] = pd.to_datetime(df["date"])
    return df
