"""Unified player identity — the canonical cross-source ID for every table.

Every other loader in this package includes a ``player_key`` column that
joins against :func:`load_player_crosswalk`. Format is ``sh_<10 hex>``
derived from a stable identity tuple (GSIS ID for NFL players, or
``COL:<name>:<position>:<draft_class>`` for pre-draft college prospects).
Built by ``scripts/build-player-crosswalk.py`` in the repo.

Helpers on this module make the crosswalk ergonomic:

- :func:`resolve_player` — name + optional position → ``player_key``
- :func:`get_player` — ``player_key`` → full crosswalk record (dict)
- :func:`load_player_profile` — merges every loader (backtest, ADP, KTC,
  KTC history, career_2026, prospect grades) for one player
"""
from __future__ import annotations

import re
import unicodedata
from functools import lru_cache
from typing import Any

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


# ── Name resolution helpers ─────────────────────────────────────────────

def _norm(s: str | None) -> str:
    """Mirror scripts/build-player-crosswalk.py::norm — same normalization
    rules the crosswalk builder used so callers can round-trip names."""
    if not s:
        return ""
    s = unicodedata.normalize("NFD", s).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"[.,'`]", "", s)
    s = re.sub(r"-", " ", s)
    s = re.sub(r"\s+(jr|sr|ii|iii|iv|v)\.?\b", "", s)
    return re.sub(r"\s+", " ", s).strip()


@lru_cache(maxsize=1)
def _crosswalk_cached() -> list[dict[str, Any]]:
    return fetch_json("public/data/player-crosswalk.json").get("players") or []


def resolve_player(name: str, position: str | None = None) -> str:
    """Return the canonical ``player_key`` for a player name.

    Matches against ``display_name`` and every historical ``all_names``
    value in the crosswalk, then filters by ``position`` if provided.
    Raises :class:`ValueError` if nothing matches or if multiple distinct
    players match and no position was provided to disambiguate.

    >>> resolve_player("Ja'Marr Chase")
    'sh_...'
    """
    target = _norm(name)
    if not target:
        raise ValueError("name is empty")
    hits: list[dict[str, Any]] = []
    for rec in _crosswalk_cached():
        candidates = {_norm(rec.get("display_name", ""))}
        for alt in rec.get("all_names") or []:
            candidates.add(_norm(alt))
        for a in rec.get("aliases") or []:
            candidates.add(_norm(a.get("name", "")))
        if target in candidates:
            if position and rec.get("position") != position:
                all_pos = set(rec.get("all_positions") or [rec.get("position", "")])
                if position not in all_pos:
                    continue
            hits.append(rec)
    if not hits:
        raise ValueError(f"No crosswalk match for {name!r}"
                         + (f" at position {position}" if position else ""))
    # Prefer exact display-name matches when there are multiple candidates —
    # "Frank Gore" vs "Frank Gore Jr." both normalize to "frank gore" once
    # the suffix is stripped, but the unambiguous display-name match is
    # the one the user asked for.
    if len(hits) > 1:
        exact = [h for h in hits if _norm(h.get("display_name", "")) == target
                 and not re.search(r"\s+(jr|sr|ii|iii|iv|v)\.?$",
                                   h.get("display_name", "").lower())]
        # If user's query has a suffix, prefer the suffixed candidate.
        if re.search(r"\s+(jr|sr|ii|iii|iv|v)\.?$", name.lower()):
            exact = [h for h in hits
                     if re.search(r"\s+(jr|sr|ii|iii|iv|v)\.?$",
                                  h.get("display_name", "").lower())]
        if len(exact) == 1:
            return exact[0]["player_key"]
        hits = exact or hits
    if len(hits) > 1:
        names = [f"{h['display_name']} ({h.get('position','?')}, "
                 f"{h.get('birth_date') or '?'})" for h in hits]
        raise ValueError(
            f"Multiple crosswalk matches for {name!r} — pass position= to "
            f"disambiguate. Candidates: {names}"
        )
    return hits[0]["player_key"]


def get_player(player_key: str) -> dict[str, Any]:
    """Return the full crosswalk record for a ``player_key`` as a dict
    (display_name, position, every known alt ID, aliases, etc.)."""
    for rec in _crosswalk_cached():
        if rec.get("player_key") == player_key:
            return dict(rec)
    raise ValueError(f"Unknown player_key: {player_key!r}")


def load_player_profile(player_key: str) -> dict[str, pd.DataFrame | dict]:
    """Merge every loader for a single player into one dict.

    Returns a mapping of ``{table_name: DataFrame}`` where each DataFrame
    is filtered to rows matching ``player_key``. ``crosswalk`` is the
    canonical record (dict). Silently skips tables without a ``player_key``
    column (KTC lacks one today; future work will add it).

    >>> profile = load_player_profile(sh.resolve_player("Ja'Marr Chase"))
    >>> profile['backtest'].shape
    (0, ...)  # Chase is in career_2026, not backtest
    >>> profile['career_2026'].iloc[0]['predictedCareerPPG']
    """
    from .adp import load_adp_ffc, load_adp_historical
    from .ktc import load_ktc, load_ktc_history
    from .predictions import load_career_backtest, load_career_predictions_2026
    from .prospects import load_prospect_grades

    out: dict[str, pd.DataFrame | dict] = {"crosswalk": get_player(player_key)}
    for label, df in (
        ("career_2026", load_career_predictions_2026()),
        ("backtest", load_career_backtest()),
        ("adp_historical", load_adp_historical()),
        ("adp_ffc", load_adp_ffc()),
    ):
        if "player_key" in df.columns:
            out[label] = df[df.player_key == player_key].reset_index(drop=True)
        else:
            out[label] = df.iloc[0:0]

    # KTC / KTC history don't carry player_key yet — match via ktc_id on
    # the crosswalk record. Fall back to name if ktc_id is missing.
    ktc_id = out["crosswalk"].get("ktc_id")  # type: ignore[union-attr]
    ktc = load_ktc()
    hist = load_ktc_history()
    if ktc_id is not None:
        out["ktc"] = ktc[ktc.playerID == ktc_id].reset_index(drop=True)
        out["ktc_history"] = hist[hist.playerID == ktc_id].reset_index(drop=True)
    else:
        out["ktc"] = ktc.iloc[0:0]
        out["ktc_history"] = hist.iloc[0:0]

    prospects = load_prospect_grades()
    pname = out["crosswalk"].get("display_name", "")  # type: ignore[union-attr]
    out["prospect_grades"] = prospects[prospects.name == pname].reset_index(drop=True)
    return out
