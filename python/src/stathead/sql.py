"""Local SQL over the loaders, via DuckDB.

``sh.query(sql)`` registers each loader as a DuckDB table and runs SQL
against it — the same surface as the web app's Data Query tab, in Python.
Tables join on ``player_key``.

    import stathead as sh

    sh.query('''
        SELECT c.name, c.predictedCareerPPG, d.value_1qb
        FROM career_2026 c
        JOIN dynasty_values d USING (player_key)
        WHERE c.percentile >= 80
        ORDER BY d.value_1qb DESC
    ''')

Requires the ``duckdb`` extra::

    pip install "stathead[duckdb]"

Tables are loaded lazily — only those a query references are materialized,
so a query that never touches ``player_stats`` (~400k rows) doesn't pay for
it. Loaded tables are cached for the process and keyed to the pinned ref;
calling :func:`~stathead.pin_version` resets the cache.

Register your own DataFrame (a roster, a league export) to join against the
model tables::

    sh.register("my_roster", roster_df)
    sh.query("SELECT * FROM career_2026 c JOIN my_roster r USING (player_key)")
"""
from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any, Callable

from . import _fetch
from .adp import load_adp_ffc, load_adp_historical
from .crosswalk import load_player_crosswalk
from .dynasty import load_dynasty_value_history, load_dynasty_values
from .predictions import load_career_backtest, load_career_predictions_2026
from .projections import (
    load_adp_value_model,
    load_career_2027,
    load_ppg_projections,
    load_redraft_projections,
    load_share_projections,
    load_taxi_predictions,
    load_volume_projections,
)
from .prospects import load_prospect_grades
from .stats import load_player_stats

if TYPE_CHECKING:
    import pandas as pd

# Table name -> loader. Names mirror the web app's Data Query tab where they
# overlap, with the projection loaders added.
_TABLES: dict[str, Callable[[], "pd.DataFrame"]] = {
    "player_crosswalk": load_player_crosswalk,
    "career_2026": load_career_predictions_2026,
    "career_2027": load_career_2027,
    "backtest": load_career_backtest,
    "prospects": load_prospect_grades,
    "player_stats": load_player_stats,
    "adp_historical": load_adp_historical,
    "adp_ffc": load_adp_ffc,
    "adp_value_model": load_adp_value_model,
    "redraft_projections": load_redraft_projections,
    "ppg_projections": load_ppg_projections,
    "volume_projections": load_volume_projections,
    "share_projections": load_share_projections,
    "taxi_predictions": load_taxi_predictions,
    "dynasty_values": load_dynasty_values,
    "dynasty_value_history": load_dynasty_value_history,
}

# Lazily-built per-process state, keyed to the pinned ref so a pin_version()
# call transparently invalidates it.
_conn: Any = None
_conn_ref: str | None = None
_registered: set[str] = set()
# DataFrames must stay referenced for the lifetime of the DuckDB view.
_frames: dict[str, "pd.DataFrame"] = {}
_user_tables: dict[str, "pd.DataFrame"] = {}

# Matches bare identifiers so we can spot which known tables a query names.
_IDENT_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def _duckdb() -> Any:
    try:
        import duckdb  # noqa: PLC0415
    except ImportError as e:  # pragma: no cover - exercised via message
        raise ImportError(
            "stathead.query() needs DuckDB. Install it with:\n"
            '    pip install "stathead[duckdb]"'
        ) from e
    return duckdb


def _connection() -> Any:
    """Return the cached connection, rebuilding if the ref changed."""
    global _conn, _conn_ref
    if _conn is None or _conn_ref != _fetch.current_ref():
        _conn = _duckdb().connect()
        _conn_ref = _fetch.current_ref()
        _registered.clear()
        _frames.clear()
        # Re-register any user tables onto the fresh connection.
        for name, df in _user_tables.items():
            _conn.register(name, df)
    return _conn


def _ensure_registered(conn: Any, names: set[str]) -> None:
    for name in names:
        if name in _registered or name in _user_tables:
            continue
        loader = _TABLES.get(name)
        if loader is None:
            continue
        df = loader()
        _frames[name] = df  # keep alive
        conn.register(name, df)
        _registered.add(name)


def _referenced_tables(sql: str) -> set[str]:
    """Known table names that appear as identifiers in the query. Loading a
    superset is harmless (an unreferenced table just goes unused), so a
    cheap token scan beats a real SQL parse."""
    tokens = {t.lower() for t in _IDENT_RE.findall(sql)}
    return {name for name in _TABLES if name in tokens}


def register(name: str, df: "pd.DataFrame") -> None:
    """Register a user DataFrame as a queryable table.

    Persists across :func:`query` calls (and across a ref change). Pass the
    same name again to replace it.
    """
    _user_tables[name] = df
    if _conn is not None:
        _conn.register(name, df)


def list_tables() -> list[str]:
    """Names available to :func:`query` — built-in loaders plus any tables
    added via :func:`register`."""
    return sorted(set(_TABLES) | set(_user_tables))


def query(sql: str) -> "pd.DataFrame":
    """Run SQL over the loader tables and return a pandas DataFrame.

    Only the tables referenced by the query are loaded (and then cached).
    See the module docstring for the available tables and examples.
    """
    conn = _connection()
    _ensure_registered(conn, _referenced_tables(sql))
    return conn.execute(sql).df()
