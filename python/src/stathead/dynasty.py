"""In-house dynasty value — the same blended value the web app shows.

The app is built on a KTC-trained forecast but displays every value on
FantasyCalc's scale. The bridge is a per-player ratio ``fc_value /
ktc_value`` (with a positional-median fallback for players below a value
floor or missing from FantasyCalc), precomputed offline into
``public/data/dynasty-fc-rescale.json`` by ``scripts/build-rescale-snapshot.cjs``.

These loaders apply that existing snapshot to the KTC values — they do not
invent a new blend. The output is the canonical "blended dynasty value"
(KTC rescaled to FC scale); no raw KTC value is exposed.

Mirrors ``src/lib/valueRescale.ts``. Keep in sync.
"""
from __future__ import annotations

from statistics import median
from typing import Any

import pandas as pd

from ._fetch import fetch_json
from .crosswalk import _norm, key_by_name_pos

_SUPPORTED_POS = ("QB", "RB", "WR", "TE")
# KTC values below this fall back to the positional-median ratio (mirrors
# RESCALE_FLOOR in valueRescale.ts).
_RESCALE_FLOOR = 500


class _Rescaler:
    """Resolve and apply per-player / positional KTC->FC ratios."""

    def __init__(self, snap: dict[str, Any]):
        self._floor = snap.get("floor", _RESCALE_FLOOR)
        self._per_player: dict[int, dict[str, float]] = {
            int(pid): v for pid, v in (snap.get("perPlayer") or {}).items()
        }
        self._positional: dict[str, dict[str, float]] = snap.get("positional") or {}

    def ratio(self, player_id: int, ktc_value: float, position: str,
              fmt: str) -> float | None:
        if position not in _SUPPORTED_POS:
            return None
        key = "oneQB" if fmt == "1qb" else "sf"
        player = self._per_player.get(player_id)
        if player and player.get(key) is not None and ktc_value >= self._floor:
            return player[key]
        return (self._positional.get(position) or {}).get(key)

    def value(self, player_id: int, ktc_value: float, position: str,
              fmt: str) -> float:
        r = self.ratio(player_id, ktc_value, position, fmt)
        return ktc_value if r is None else round(ktc_value * r)


def _load_rescaler() -> _Rescaler:
    """Load the committed snapshot; if absent, derive one from the current
    KTC + FantasyCalc snapshots (mirrors buildRescaleSnapshot)."""
    try:
        return _Rescaler(fetch_json("public/data/dynasty-fc-rescale.json"))
    except Exception:
        return _Rescaler(_build_snapshot())


def _build_snapshot() -> dict[str, Any]:
    """Fallback: build the KTC->FC ratio snapshot from live values, exactly
    as scripts/build-rescale-snapshot.cjs does."""
    ktc = fetch_json("public/data/ktc_rankings_1qb.json") or []
    fc_1qb = fetch_json("public/data/fantasycalc_dynasty_1qb.json") or []
    fc_sf = fetch_json("public/data/fantasycalc_dynasty_sf.json") or []

    def fc_map(src: list[dict]) -> dict[tuple[str, str], float]:
        out: dict[tuple[str, str], float] = {}
        for r in src:
            p = r.get("player") or {}
            out[(_norm(p.get("name", "")), p.get("position", ""))] = r.get("value")
        return out

    fc1q, fcsf = fc_map(fc_1qb), fc_map(fc_sf)
    per_player: dict[str, dict[str, float]] = {}
    samples: dict[str, dict[str, list[float]]] = {
        pos: {"oneQB": [], "sf": []} for pos in _SUPPORTED_POS
    }
    for k in ktc:
        pos = k.get("position", "")
        if pos not in _SUPPORTED_POS:
            continue
        key = (_norm(k.get("playerName", "")), pos)
        entry: dict[str, float] = {}
        fc1 = fc1q.get(key)
        fcs = fcsf.get(key)
        if fc1 is not None and (k.get("value") or 0) >= _RESCALE_FLOOR:
            entry["oneQB"] = fc1 / k["value"]
            samples[pos]["oneQB"].append(entry["oneQB"])
        if fcs is not None and (k.get("superflexValue") or 0) >= _RESCALE_FLOOR:
            entry["sf"] = fcs / k["superflexValue"]
            samples[pos]["sf"].append(entry["sf"])
        if entry:
            per_player[str(k["playerID"])] = entry

    positional = {
        pos: {
            "oneQB": median(samples[pos]["oneQB"]) if samples[pos]["oneQB"] else 1,
            "sf": median(samples[pos]["sf"]) if samples[pos]["sf"] else 1,
        }
        for pos in _SUPPORTED_POS
    }
    return {"floor": _RESCALE_FLOOR, "perPlayer": per_player, "positional": positional}


def load_dynasty_values() -> pd.DataFrame:
    """Blended dynasty market value (1QB + Superflex) — the value the web
    app displays.

    KTC rankings rescaled into FantasyCalc's scale via the in-house
    per-player ratio snapshot. Unsupported positions (K, picks) keep their
    raw value; everything else is the rescaled blend.

    Columns: ``player_key``, ``name``, ``position``, ``team``, ``age``,
    ``value_1qb``, ``value_superflex``, ``positionRank``, ``isRookie``.
    Sorted by ``value_1qb`` desc.
    """
    ktc = fetch_json("public/data/ktc_rankings_1qb.json") or []
    rescaler = _load_rescaler()
    keymap = key_by_name_pos()

    rows: list[dict[str, Any]] = []
    for r in ktc:
        pid, pos = r.get("playerID"), r.get("position", "")
        name = r.get("playerName", "")
        rows.append({
            "player_key": keymap.get((_norm(name), pos)),
            "name": name,
            "position": pos,
            "team": r.get("team"),
            "age": r.get("age"),
            "value_1qb": rescaler.value(pid, r.get("value") or 0, pos, "1qb"),
            "value_superflex": rescaler.value(pid, r.get("superflexValue") or 0, pos, "superflex"),
            "positionRank": r.get("positionRank"),
            "isRookie": r.get("isRookie"),
        })
    df = pd.DataFrame(rows)
    return df.sort_values("value_1qb", ascending=False,
                          na_position="last").reset_index(drop=True)


def load_dynasty_value_history() -> pd.DataFrame:
    """Daily dynasty value history (1QB + Superflex), rescaled to FC scale.

    Same per-player ratio as :func:`load_dynasty_values`, applied to KTC's
    daily history. One row per (player, date) with both formats side-by-side.

    Columns: ``player_key``, ``name``, ``position``, ``date``,
    ``value_1qb``, ``value_superflex``. Sorted by ``name``, ``date``.
    """
    ktc = fetch_json("public/data/ktc_rankings_1qb.json") or []
    history = fetch_json("public/data/ktc_history.json") or []
    rescaler = _load_rescaler()
    keymap = key_by_name_pos()

    # KTC history is keyed by playerID; map it back to name/position/team.
    info = {
        r.get("playerID"): (r.get("playerName", ""), r.get("position", ""))
        for r in ktc
    }

    rows: list[dict[str, Any]] = []
    for h in history:
        pid = h.get("playerID")
        name, pos = info.get(pid, ("", ""))
        if not name:
            continue
        key = keymap.get((_norm(name), pos))
        sf_by_date = {
            p.get("d"): p.get("v")
            for p in (h.get("superflex") or {}).get("valueHistory") or []
        }
        for p in (h.get("oneQB") or {}).get("valueHistory") or []:
            date, v1 = p.get("d"), p.get("v")
            vsf = sf_by_date.get(date)
            rows.append({
                "player_key": key,
                "name": name,
                "position": pos,
                "date": date,
                "value_1qb": rescaler.value(pid, v1 or 0, pos, "1qb"),
                "value_superflex": (rescaler.value(pid, vsf, pos, "superflex")
                                    if vsf is not None else None),
            })
    df = pd.DataFrame(rows)
    return df.sort_values(["name", "date"]).reset_index(drop=True)
