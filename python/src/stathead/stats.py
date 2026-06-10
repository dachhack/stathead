"""Weekly NFL player stats — per-player per-week box scores, 2010-present."""
from __future__ import annotations

import io

import pandas as pd

from ._fetch import fetch_csv_gz
from .crosswalk import key_by_gsis

# nflverse weekly stats ship one gzipped CSV per season. Coverage grows as
# the repo's refresh workflow commits the current year, so we probe a
# generous range and skip seasons not present in the pinned ref.
_SEASONS = tuple(range(2010, 2027))


def load_player_stats(season: int | None = None) -> pd.DataFrame:
    """Per-player per-week NFL stats (regular + postseason).

    One row per (player, season, week). Includes passing / rushing /
    receiving box-score columns plus ``fantasy_points`` and
    ``fantasy_points_ppr``, and a canonical ``player_key`` stamped from the
    crosswalk so this joins cleanly to every other loader.

    Pass a ``season`` to load a single year, or leave ``None`` to load every
    season available in the pinned ref (2010-present, ~400k rows).

    The upstream schema drifted in 2025 (``recent_team`` → ``team``,
    ``interceptions`` → ``passing_interceptions``, ``sacks`` →
    ``sacks_suffered``). Both spellings are kept side-by-side when present;
    ``COALESCE`` / :meth:`~pandas.Series.combine_first` in your own code to
    normalize across years.

    Columns (non-exhaustive): ``player_key``, ``player_id``, ``player_name``,
    ``player_display_name``, ``position``, ``recent_team`` / ``team``,
    ``season``, ``week``, ``season_type``, ``opponent_team``,
    ``passing_yards``, ``passing_tds``, ``rushing_yards``, ``rushing_tds``,
    ``carries``, ``receptions``, ``targets``, ``receiving_yards``,
    ``receiving_tds``, ``fantasy_points``, ``fantasy_points_ppr``.
    """
    seasons = [season] if season is not None else list(_SEASONS)
    frames: list[pd.DataFrame] = []
    for s in seasons:
        try:
            raw = fetch_csv_gz(f"public/data/player_stats_{s}.csv.gz")
        except Exception:
            continue
        frames.append(pd.read_csv(io.BytesIO(raw), low_memory=False))
    if not frames:
        return pd.DataFrame()
    # sort=False keeps first-seen column order; concat unions columns across
    # the 2024/2025 schema drift (missing cells become NaN), mirroring the
    # web app's UNION ALL BY NAME.
    out = pd.concat(frames, ignore_index=True, sort=False)
    out.insert(0, "player_key", out["player_id"].astype("string").map(key_by_gsis()))
    return out
