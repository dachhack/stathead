"""In-house dynasty value blend.

Rather than re-publishing any single vendor's dynasty rankings verbatim
(some vendors' terms don't permit third-party redistribution), this module
derives a *consensus* value: each available source is rescaled to a common
0-10000 scale, then the sources that cover a given player are averaged. No
raw vendor value is exposed — only the blended, normalized result, plus an
``n_sources_*`` coverage count.

Sources blended (both 1QB and Superflex formats):

- KeepTradeCut  (``ktc_rankings_1qb.json`` / ``ktc_history.json``)
- FantasyCalc   (``fantasycalc_dynasty_{1qb,sf}.json`` and the matching
                 ``fantasycalc_history_*`` files)
"""
from __future__ import annotations

from collections import defaultdict
from typing import Any

import pandas as pd

from ._fetch import fetch_json
from .crosswalk import _norm, key_by_name_pos


def _rescale_to_10k(values: list[float]) -> list[float]:
    """Linear rescale so the source's max maps to 10000 (sources already
    start at 0). Returns the input unchanged if the max is non-positive."""
    hi = max(values) if values else 0.0
    if hi <= 0:
        return values
    factor = 10000.0 / hi
    return [v * factor for v in values]


def _blend(samples: list[float]) -> float | None:
    return round(sum(samples) / len(samples), 1) if samples else None


def load_dynasty_values() -> pd.DataFrame:
    """Blended in-house dynasty market value, 1QB + Superflex.

    Each source is rescaled to 0-10000 and the sources covering a player are
    averaged, so a player ranked by more sources gets a steadier number. The
    output is a derived consensus — no single vendor's raw value appears.

    Columns: ``player_key``, ``name``, ``position``, ``team``, ``age``,
    ``value_1qb``, ``value_superflex``, ``n_sources_1qb``,
    ``n_sources_superflex``, ``isRookie``. Sorted by ``value_1qb`` desc.
    """
    ktc = fetch_json("public/data/ktc_rankings_1qb.json") or []
    fc_1qb = fetch_json("public/data/fantasycalc_dynasty_1qb.json") or []
    fc_sf = fetch_json("public/data/fantasycalc_dynasty_sf.json") or []

    # Pre-rescale each source so every contribution is on the same 0-10000
    # footing before averaging.
    ktc_1qb_n = _rescale_to_10k([float(r.get("value") or 0) for r in ktc])
    ktc_sf_n = _rescale_to_10k([float(r.get("superflexValue") or 0) for r in ktc])
    fc_1qb_n = _rescale_to_10k([float(r.get("value") or 0) for r in fc_1qb])
    fc_sf_n = _rescale_to_10k([float(r.get("value") or 0) for r in fc_sf])

    # (norm_name, position) -> accumulator
    acc: dict[tuple[str, str], dict[str, Any]] = {}

    def _slot(name: str, position: str) -> dict[str, Any]:
        key = (_norm(name), position or "")
        rec = acc.get(key)
        if rec is None:
            rec = {
                "name": name, "position": position,
                "team": None, "age": None, "isRookie": None,
                "onq": [], "sf": [],
            }
            acc[key] = rec
        return rec

    for r, v1, vsf in zip(ktc, ktc_1qb_n, ktc_sf_n):
        rec = _slot(r.get("playerName", ""), r.get("position", ""))
        rec["team"] = rec["team"] or r.get("team")
        rec["age"] = rec["age"] if rec["age"] is not None else r.get("age")
        if rec["isRookie"] is None:
            rec["isRookie"] = r.get("isRookie")
        if v1 > 0:
            rec["onq"].append(v1)
        if vsf > 0:
            rec["sf"].append(vsf)

    for src, normed, bucket in ((fc_1qb, fc_1qb_n, "onq"), (fc_sf, fc_sf_n, "sf")):
        for r, val in zip(src, normed):
            p = r.get("player") or {}
            rec = _slot(p.get("name", ""), p.get("position", ""))
            rec["team"] = rec["team"] or p.get("maybeTeam")
            if rec["age"] is None:
                rec["age"] = p.get("maybeAge")
            if val > 0:
                rec[bucket].append(val)

    keymap = key_by_name_pos()
    rows: list[dict[str, Any]] = []
    for (norm_name, pos), rec in acc.items():
        rows.append({
            "player_key": keymap.get((norm_name, pos)),
            "name": rec["name"],
            "position": rec["position"],
            "team": rec["team"],
            "age": rec["age"],
            "value_1qb": _blend(rec["onq"]),
            "value_superflex": _blend(rec["sf"]),
            "n_sources_1qb": len(rec["onq"]),
            "n_sources_superflex": len(rec["sf"]),
            "isRookie": rec["isRookie"],
        })
    df = pd.DataFrame(rows)
    return df.sort_values("value_1qb", ascending=False,
                          na_position="last").reset_index(drop=True)


def load_dynasty_value_history() -> pd.DataFrame:
    """Blended daily dynasty value history, 1QB + Superflex.

    Same blend as :func:`load_dynasty_values`, applied per (player, date):
    each source's history is rescaled to 0-10000 and averaged across the
    sources present on that date.

    Columns: ``player_key``, ``name``, ``position``, ``date``,
    ``value_1qb``, ``value_superflex``, ``n_sources_1qb``,
    ``n_sources_superflex``. Sorted by ``name``, ``date``.
    """
    ktc_rank = fetch_json("public/data/ktc_rankings_1qb.json") or []
    ktc_hist = fetch_json("public/data/ktc_history.json") or []
    fc_hist_1qb = fetch_json("public/data/fantasycalc_history_dynasty_1qb.json") or []
    fc_hist_sf = fetch_json("public/data/fantasycalc_history_dynasty_sf.json") or []

    # KTC history is keyed by playerID; map it back to name + position.
    ktc_info = {
        r.get("playerID"): (r.get("playerName", ""), r.get("position", ""))
        for r in ktc_rank
    }

    # Gather raw (name, pos, date, value) tuples per source + format, then
    # rescale each source as a whole so a day's blend mixes comparable units.
    def _ktc_points(field: str) -> list[tuple[str, str, str, float]]:
        pts: list[tuple[str, str, str, float]] = []
        for h in ktc_hist:
            name, pos = ktc_info.get(h.get("playerID"), ("", ""))
            if not name:
                continue
            for p in (h.get(field) or {}).get("valueHistory") or []:
                pts.append((name, pos, p.get("d"), float(p.get("v") or 0)))
        return pts

    def _fc_points(src: list[dict]) -> list[tuple[str, str, str, float]]:
        pts: list[tuple[str, str, str, float]] = []
        for r in src:
            name, pos = r.get("name", ""), r.get("position", "")
            for p in r.get("valueHistory") or []:
                pts.append((name, pos, p.get("d"), float(p.get("v") or 0)))
        return pts

    sources = [
        (_ktc_points("oneQB"), "onq"),
        (_ktc_points("superflex"), "sf"),
        (_fc_points(fc_hist_1qb), "onq"),
        (_fc_points(fc_hist_sf), "sf"),
    ]

    # (norm_name, pos, date) -> {"onq": [...], "sf": [...], name, position}
    acc: dict[tuple[str, str, str], dict[str, Any]] = {}
    for pts, bucket in sources:
        normed = _rescale_to_10k([v for *_, v in pts])
        for (name, pos, date, _raw), val in zip(pts, normed):
            if not date or val <= 0:
                continue
            key = (_norm(name), pos or "", date)
            rec = acc.get(key)
            if rec is None:
                rec = {"name": name, "position": pos, "date": date,
                       "onq": [], "sf": []}
                acc[key] = rec
            rec[bucket].append(val)

    keymap = key_by_name_pos()
    rows: list[dict[str, Any]] = []
    for (norm_name, pos, _date), rec in acc.items():
        rows.append({
            "player_key": keymap.get((norm_name, pos)),
            "name": rec["name"],
            "position": rec["position"],
            "date": rec["date"],
            "value_1qb": _blend(rec["onq"]),
            "value_superflex": _blend(rec["sf"]),
            "n_sources_1qb": len(rec["onq"]),
            "n_sources_superflex": len(rec["sf"]),
        })
    df = pd.DataFrame(rows)
    return df.sort_values(["name", "date"]).reset_index(drop=True)
