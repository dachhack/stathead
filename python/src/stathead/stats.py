"""Weekly NFL player stats — per-player per-week box scores, 2010-present."""
from __future__ import annotations

import io

import pandas as pd

from ._fetch import fetch_csv_gz, fetch_json
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


def load_depth_charts() -> pd.DataFrame:
    """Each team's newest published depth chart (nflverse, CC-BY-4.0; the
    teams' charts as carried by ESPN): offense, defense and special teams,
    every slot and rank, with roster status and StatHead's own depth-order
    rank for QB/RB/WR/TE. One row per (team, slot, player).

    Slot-aware: the three receiver slots all carry ``pos`` WR, so ``label``
    numbers them WR1 / WR2 / WR3 by slot order. ``rank`` is the chart's rank
    across the position (the WR slots carry 1/4/7, 2/5/8, 3/6, so a team's
    receiver order is its rank order); ``slot_rank`` is the order within the
    slot and ``starter`` the first in it.

    Columns: ``team``, ``group`` (offense / defense / specialTeams),
    ``slot``, ``pos``, ``label``, ``rank``, ``slot_rank``, ``starter``,
    ``name``, ``gsis_id``, ``espn_id``, ``status``, ``depth_score``,
    ``depth_rank``, ``snapshot`` (the team's snapshot time), ``season``.
    """
    data = fetch_json("public/data/depth-charts-2026.json")
    teams = data.get("teams") or {}
    rows = []
    for r in data.get("rows") or []:
        rows.append({
            "team": r.get("team"), "group": r.get("group"), "slot": r.get("slot"), "pos": r.get("pos"),
            "label": r.get("label"), "rank": r.get("rank"), "slot_rank": r.get("slotRank"),
            "starter": bool(r.get("starter")), "name": r.get("name"), "gsis_id": r.get("gsis_id"),
            "espn_id": r.get("espn_id"), "status": r.get("status"),
            "depth_score": r.get("depthScore"), "depth_rank": r.get("depthRank"),
            "snapshot": (teams.get(r.get("team")) or {}).get("snapshot"),
        })
    df = pd.DataFrame(rows)
    df["season"] = data.get("season")
    return df


def load_depth_chart_changes(window: str = "previous") -> pd.DataFrame:
    """Slot-level depth-chart moves per team: ``window="previous"`` against
    each team's previous snapshot (about half a day), ``"7d"`` against its
    newest snapshot at least seven days old. ``kind`` is up / down / added /
    removed on the chart's rank; ``new_starter`` marks a player who became
    first in his slot.

    Columns: ``team``, ``group``, ``label``, ``pos``, ``slot``, ``name``,
    ``gsis_id``, ``from_rank``, ``to_rank``, ``kind``, ``new_starter``,
    ``since`` (the reference snapshot), ``window``, ``season``.
    """
    data = fetch_json("public/data/depth-charts-2026.json")
    key = "changes7d" if window == "7d" else "changes"
    rows = [{
        "team": c.get("team"), "group": c.get("group"), "label": c.get("label"), "pos": c.get("pos"),
        "slot": c.get("slot"), "name": c.get("name"), "gsis_id": c.get("gsis_id"),
        "from_rank": c.get("from"), "to_rank": c.get("to"), "kind": c.get("kind"),
        "new_starter": bool(c.get("newStarter")), "since": c.get("since"), "window": c.get("window"),
    } for c in data.get(key) or []]
    df = pd.DataFrame(rows, columns=["team", "group", "label", "pos", "slot", "name", "gsis_id", "from_rank",
                                     "to_rank", "kind", "new_starter", "since", "window"])
    df["season"] = data.get("season")
    return df
