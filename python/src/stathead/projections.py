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


def load_weekly_projections() -> pd.DataFrame:
    """Per-week 2026 projections — the season projection split across the
    schedule, one row per player per scheduled game (17 rows/player; byes
    omitted). Covers QB/RB/WR/TE plus kickers (position ``K``, the current
    depth-chart PK1 per team) and team defenses (position ``DST``, name
    ``"<TEAM> DST"``, ``sleeper_id`` = team code).

    Weekly points = season PPG x opponent defense-vs-position multiplier
    (prior-season PPR allowed per game vs league average, heavily regressed)
    x home/away nudge, normalized per team so the 17 games sum back to the
    season line. Points assume the player plays; ``gp`` carries the season
    games (health) discount. Half/Std conversion: weekly receptions scale
    with the same multiplier, so ``rec_w = recPG * proj_ppr / ppg``.

    Roster status (QB/RB/WR/TE, from the nflverse roster at build time):
    ``status`` is ``ACT`` / ``RES`` (IR, PUP, NFI) / ``EXE`` (commissioner
    exempt) / ``DEV`` (practice squad) / ``INA`` (game-day inactive) /
    ``FA`` (unrostered), or None for K/DST/IDP rows. ``active`` is False for
    RES/EXE/DEV/FA rows, whose ``proj_ppr`` is 0 from the current week on;
    ``proj_ppr_if_active`` on those rows is the un-zeroed conditional
    number (NaN elsewhere). Retired and cut players carry no rows.
    ``backup`` is True for a 1-3 game season line on a depth-2+ player:
    ``proj_ppr`` is then a per-game rate conditional on playing, not an
    expectation of starting — rank those below starters. ``depth`` is the
    position rank on the newest nflverse depth chart (1 = starter).

    Columns: ``player_key``, ``name``, ``position``, ``team``, ``gsis_id``,
    ``sleeper_id``, ``depth``, ``status``, ``active``, ``backup``, ``week``,
    ``opp``, ``home``, ``matchup_mult``, ``proj_ppr``, ``proj_ppr_if_active``,
    ``ppg``, ``recPG``, ``gp``, ``season``. The gsis/sleeper ids are stamped
    at build time from the player crosswalk (None for pre-NFL rookies).

    Metadata on ``df.attrs``: ``meta`` (generatedAt, method note,
    ``playedThrough`` = last week with every game final, ``currentWeek``,
    ``statusNote``) and ``def_vs_pos`` (per-team defense-vs-position
    multiplier table).
    """
    data = fetch_json("public/data/weekly-projections-2026.json")
    team_weeks = {
        team: {g["w"]: g for g in games}
        for team, games in (data.get("teamWeeks") or {}).items()
    }
    def_vs_pos = data.get("defVsPos") or {}
    rows = []
    for p in data.get("players") or []:
        sched = team_weeks.get(p["team"], {})
        if_active = p.get("wkIfActive")
        for i, pts in enumerate(p["wk"]):
            week = i + 1
            game = sched.get(week)
            if pts is None or game is None:
                continue
            rows.append({
                "name": p["name"],
                "position": p["pos"],
                "team": p["team"],
                "gsis_id": p.get("gsis"),
                "sleeper_id": p.get("sleeper"),
                "depth": p.get("depth"),
                "status": p.get("status"),
                "active": p.get("active", True),
                "backup": bool(p.get("backup", False)),
                "week": week,
                "opp": game["opp"],
                "home": game["home"],
                "matchup_mult": def_vs_pos.get(game["opp"], {}).get(p["pos"]),
                "proj_ppr": pts,
                "proj_ppr_if_active": if_active[i] if if_active else None,
                "ppg": p["ppg"],
                "recPG": p["recPG"],
                "gp": p["gp"],
            })
    df = pd.DataFrame(rows)
    df["season"] = data.get("season")
    df = _stamp_keys(df)
    df.attrs["meta"] = {
        "generatedAt": data.get("generatedAt"),
        "note": data.get("note"),
        "playedThrough": data.get("playedThrough"),
        "currentWeek": data.get("currentWeek"),
        "statusNote": data.get("statusNote"),
    }
    df.attrs["def_vs_pos"] = def_vs_pos
    return df


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


def load_matchups() -> pd.DataFrame:
    """Weekly strength of matchup, defense side: what each defense has
    allowed per game to QB / RB / WR / TE this season, with ranks
    (1 = most allowed = softest matchup for the offense), last season's
    figure and the StatHead model factor the weekly projections apply.
    One row per (team, position). Computed by StatHead from nflverse weekly
    stats (``scripts/build-matchups.py``), so nothing here is third-party.

    Columns: ``team``, ``position``, ``games``, ``ppr_allowed_pg``,
    ``rec_allowed_pg``, ``half_allowed_pg``, ``std_allowed_pg``,
    ``rank_ppr``, ``rank_half``, ``rank_std``, ``prior_games``,
    ``prior_ppr_allowed_pg``, ``prior_rec_allowed_pg``, ``factor``,
    ``factor_rank``, ``season``, ``played_through``, ``current_week``.
    TE-premium: ``ppr_allowed_pg + bonus * rec_allowed_pg`` for TEs.
    """
    data = fetch_json("public/data/matchups-2026.json")
    rows = []
    for team, by_pos in (data.get("defenses") or {}).items():
        for pos, c in by_pos.items():
            ppr, rec = c.get("ppr"), c.get("rec")
            prior = c.get("prior") or {}
            rank = c.get("rank") or {}
            rows.append({
                "team": team, "position": pos, "games": c.get("g", 0),
                "ppr_allowed_pg": ppr, "rec_allowed_pg": rec,
                "half_allowed_pg": None if ppr is None else round(ppr - 0.5 * (rec or 0), 2),
                "std_allowed_pg": None if ppr is None else round(ppr - (rec or 0), 2),
                "rank_ppr": rank.get("ppr"), "rank_half": rank.get("half"), "rank_std": rank.get("std"),
                "prior_games": prior.get("g", 0),
                "prior_ppr_allowed_pg": prior.get("ppr"), "prior_rec_allowed_pg": prior.get("rec"),
                "factor": c.get("factor"), "factor_rank": c.get("factorRank"),
            })
    df = pd.DataFrame(rows)
    df["season"] = data.get("season")
    df["played_through"] = data.get("playedThrough")
    df["current_week"] = data.get("currentWeek")
    return df


def load_matchup_schedule() -> pd.DataFrame:
    """Weekly strength of matchup, schedule side: one row per team-game with
    the opponent and, per position, what that opponent has allowed per game
    this season (PPR and receptions, so any scoring is derivable), its rank
    (1 = most allowed) and the StatHead model factor. Byes are the missing
    weeks; ``played`` marks final games.

    Columns: ``team``, ``week``, ``opp``, ``home``, ``played``, then for each
    of QB/RB/WR/TE ``opp_<pos>_ppr_allowed_pg``, ``opp_<pos>_rec_allowed_pg``,
    ``opp_<pos>_rank_ppr``, ``opp_<pos>_factor``; plus ``season``,
    ``played_through``, ``current_week``.
    """
    data = fetch_json("public/data/matchups-2026.json")
    defenses = data.get("defenses") or {}
    positions = data.get("positions") or ["QB", "RB", "WR", "TE"]
    rows = []
    for team, games in (data.get("schedule") or {}).items():
        for g in games:
            row = {"team": team, "week": g.get("w"), "opp": g.get("opp"),
                   "home": bool(g.get("home")), "played": bool(g.get("played"))}
            opp = defenses.get(g.get("opp")) or {}
            for pos in positions:
                c = opp.get(pos) or {}
                row[f"opp_{pos}_ppr_allowed_pg"] = c.get("ppr")
                row[f"opp_{pos}_rec_allowed_pg"] = c.get("rec")
                row[f"opp_{pos}_rank_ppr"] = (c.get("rank") or {}).get("ppr")
                row[f"opp_{pos}_factor"] = (g.get("factor") or {}).get(pos, c.get("factor"))
            rows.append(row)
    df = pd.DataFrame(rows)
    df["season"] = data.get("season")
    df["played_through"] = data.get("playedThrough")
    df["current_week"] = data.get("currentWeek")
    return df
