"""Weekly player props and rest-of-game projections.

Two artifacts, one math module:

``load_player_props()``
    The full projected stat line for every player-week — attempts,
    completions, yards, TDs, targets, receptions — the season projection
    split across the schedule by opponent defense-vs-position-vs-*stat*
    strength, normalized so the weeks sum back to the season line.

``load_quarter_splits()``
    How a game distributes across its quarters, measured from play-by-play:
    per-quarter shares by position and stat, game-script multipliers by
    score differential, and weights for how much a player's in-game pace
    should override his pre-game projection.

``price_props()`` / ``rest_of_game()``
    Turn those means into a prop: the half-point line nearest a coin flip,
    the probability of clearing it, and a p10-p90 range. Counting stats use
    a negative binomial (var = mu + mu^2/k), yardage a gamma with
    shape = 1/cv^2, and low-volume yardage is zero-inflated by the
    probability the underlying carry or catch never happens.

The distributions match ``src/lib/playerProps.ts`` exactly, so a prop quoted
here, in the web app, or through the MCP server is the same number.
"""
from __future__ import annotations

import math
from typing import Any, Dict, Iterable, Mapping, Optional, Sequence

import pandas as pd

from ._fetch import fetch_json
from .crosswalk import _norm, key_by_name_pos

_PROPS_PATH = "public/data/player-props-2026.json"
_SPLITS_PATH = "public/data/quarter-splits-2025.json"
_INSEASON_PATH = "public/data/inseason-projections-{season}.json"
_BACKTEST_PATH = "public/data/weekly-backtest-{season}.json"

#: Yardage stat -> the counting stat that has to happen for it to be non-zero.
YARDS_VOLUME_STAT = {"passYds": "passAtt", "rushYds": "rushAtt", "recYds": "rec"}

#: Fallback spread for a cell the builders could not estimate.
DEFAULT_DISPERSION = {"k": 3.0, "cv": 1.2}


# ── distributions ─────────────────────────────────────────────────────────

def _gamma_p(a: float, x: float) -> float:
    """Regularized lower incomplete gamma P(a, x)."""
    if x <= 0 or a <= 0:
        return 0.0
    if x < a + 1:
        ap, total, term = a, 1.0 / a, 1.0 / a
        for _ in range(300):
            ap += 1
            term *= x / ap
            total += term
            if abs(term) < abs(total) * 1e-12:
                break
        return total * math.exp(-x + a * math.log(x) - math.lgamma(a))
    tiny = 1e-300
    b, c, d = x + 1 - a, 1 / tiny, 1.0 / (x + 1 - a)
    h = d
    for i in range(1, 301):
        an = -i * (i - a)
        b += 2
        d = an * d + b
        if abs(d) < tiny:
            d = tiny
        c = b + an / c
        if abs(c) < tiny:
            c = tiny
        d = 1 / d
        delta = d * c
        h *= delta
        if abs(delta - 1) < 1e-12:
            break
    return 1 - math.exp(-x + a * math.log(x) - math.lgamma(a)) * h


def _beta_cf(a: float, b: float, x: float) -> float:
    tiny = 1e-300
    qab, qap, qam = a + b, a + 1, a - 1
    c = 1.0
    d = 1 - qab * x / qap
    if abs(d) < tiny:
        d = tiny
    d = 1 / d
    h = d
    for m in range(1, 301):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1 + aa * d
        if abs(d) < tiny:
            d = tiny
        c = 1 + aa / c
        if abs(c) < tiny:
            c = tiny
        d = 1 / d
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1 + aa * d
        if abs(d) < tiny:
            d = tiny
        c = 1 + aa / c
        if abs(c) < tiny:
            c = tiny
        d = 1 / d
        delta = d * c
        h *= delta
        if abs(delta - 1) < 1e-12:
            break
    return h


def _beta_i(a: float, b: float, x: float) -> float:
    """Regularized incomplete beta I_x(a, b)."""
    if x <= 0:
        return 0.0
    if x >= 1:
        return 1.0
    front = math.exp(
        math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b)
        + a * math.log(x) + b * math.log(1 - x)
    )
    if x < (a + 1) / (a + b + 2):
        return front * _beta_cf(a, b, x) / a
    return 1 - front * _beta_cf(b, a, 1 - x) / b


def over_prob(kind: str, mu: float, disp: Optional[Mapping[str, float]],
              line: float, zero_prob: float = 0.0) -> float:
    """P(X > line). ``kind`` is ``"count"`` or ``"yards"``.

    ``zero_prob`` handles zero-inflated yardage: a receiver's *rushing*
    yards are zero in most games because he never gets a carry, and a plain
    gamma puts no mass exactly at zero.
    """
    d = dict(DEFAULT_DISPERSION)
    if disp:
        d.update({k: v for k, v in disp.items() if k in ("k", "cv")})
    if mu <= 0:
        return 0.0
    if kind == "count":
        k = max(float(d["k"]), 0.05)
        n = math.floor(line)
        if n < 0:
            return 1.0
        return min(1.0, max(0.0, 1 - _beta_i(k, n + 1, k / (k + mu))))
    p0 = min(max(zero_prob, 0.0), 0.99)
    if line <= 0:
        return 1 - p0
    cv = max(float(d["cv"]), 0.05)
    shape = 1 / (cv * cv)

    def surv(m: float) -> float:
        return min(1.0, max(0.0, 1 - _gamma_p(shape, line / (m / shape))))

    return surv(mu) if p0 <= 0 else (1 - p0) * surv(mu / (1 - p0))


def quantile(kind: str, mu: float, disp: Optional[Mapping[str, float]],
             p: float, zero_prob: float = 0.0) -> float:
    """Value x with P(X <= x) = p."""
    if mu <= 0:
        return 0.0
    lo, hi = 0.0, max(mu * 12, 5.0)
    for _ in range(60):
        mid = (lo + hi) / 2
        if 1 - over_prob(kind, mu, disp, mid, zero_prob) < p:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def snap_line(value: float, step: float = 1.0) -> float:
    """Snap onto the half-point grid a book would quote: 0.5, 1.5, 2.5, …"""
    grid = max(step, 0.5)
    return max(round((value - 0.5) / grid) * grid + 0.5, 0.5)


def zero_prob_for_yards(stat: str, line: Mapping[str, float],
                        disp: Mapping[str, Mapping[str, float]]) -> float:
    """P(the volume behind a yardage stat is zero), from the negative
    binomial on its paired counting stat: P(X = 0) = (k / (k + mu))^k."""
    vol_stat = YARDS_VOLUME_STAT.get(stat)
    if not vol_stat:
        return 0.0
    vol_mu = line.get(vol_stat)
    if vol_mu is None:
        return 0.0
    if vol_mu <= 0:
        return 1.0
    k = max(float((disp.get(vol_stat) or DEFAULT_DISPERSION)["k"]), 0.05)
    return (k / (k + vol_mu)) ** k


def price_prop(stat: str, mu: float, disp: Optional[Mapping[str, float]],
               count_stats: Iterable[str], line: Optional[float] = None,
               zero_prob: float = 0.0) -> Dict[str, Any]:
    """Price one prop: the half-point line nearest a coin flip (or the one
    you pass), its over/under, and a p10-p90 range.

    On a discrete stat the median can sit right on a jump — a 0.79-TD player
    has median 1, but 1.5 is a 20% prop and 0.5 is the 50/50 one — so the
    line is chosen by scanning the grid, not by rounding the median.
    """
    kind = "count" if stat in set(count_stats) else "yards"
    if line is None:
        anchor = snap_line(quantile(kind, mu, disp, 0.5, zero_prob))
        step = max(1.0, round(mu / 40)) if kind == "yards" and mu >= 60 else 1.0
        best, best_gap = anchor, float("inf")
        for i in range(-3, 4):
            cand = anchor + i * step
            if cand < 0.5:
                continue
            gap = abs(over_prob(kind, mu, disp, cand, zero_prob) - 0.5)
            if gap < best_gap - 1e-9:
                best, best_gap = cand, gap
        line = best
    over = over_prob(kind, mu, disp, line, zero_prob)
    return {
        "stat": stat,
        "mean": mu,
        "line": line,
        "over": over,
        "under": 1 - over,
        "p10": quantile(kind, mu, disp, 0.1, zero_prob),
        "p90": quantile(kind, mu, disp, 0.9, zero_prob),
    }


def anytime_td_prob(expected_tds: float) -> float:
    """P(at least one TD), pooling rushing + receiving as Poisson."""
    return 1 - math.exp(-max(expected_tds, 0.0))


# ── loaders ───────────────────────────────────────────────────────────────

def _props_doc() -> Dict[str, Any]:
    return fetch_json(_PROPS_PATH)


def load_player_props(week: Optional[int] = None,
                      position: Optional[str] = None) -> pd.DataFrame:
    """Per-week projected stat lines, one row per player per scheduled game
    (byes omitted).

    Columns: ``player_key``, ``name``, ``position``, ``team``, ``gsis_id``,
    ``sleeper_id``, ``week``, ``opp``, ``home``, ``availability``, ``gp``,
    plus one column per stat (``passYds``, ``rec``, ``recYds``, …; a stat a
    position doesn't post is NaN), ``def_grade_pos`` and ``def_grade_overall``
    (0-100, 100 = toughest defense) and ``matchup_mult`` (the normalized
    fantasy-points multiplier for that week).

    Numbers are conditional on the player suiting up; ``availability`` is the
    probability he does.

    Metadata on ``df.attrs``: ``meta`` (generatedAt + method note),
    ``dispersion`` (spread parameters per position/stat), ``count_stats``,
    ``defense`` (strength of matchup overall, by position and by stat) and
    ``bye_weeks``.
    """
    data = _props_doc()
    team_weeks = {
        team: {g["w"]: g for g in games}
        for team, games in (data.get("teamWeeks") or {}).items()
    }
    defense = data.get("defense") or {}
    pos_mult = data.get("posMult") or {}
    stat_keys = data.get("statKeys") or {}
    rows = []
    for p in data.get("players") or []:
        keys = stat_keys.get(p["pos"]) or []
        sched = team_weeks.get(p["team"], {})
        for i, line in enumerate(p.get("wk") or []):
            wk = i + 1
            game = sched.get(wk)
            if line is None or game is None:
                continue
            if week is not None and wk != week:
                continue
            if position and p["pos"] != position:
                continue
            opp_def = defense.get(game["opp"]) or {}
            row = {
                "name": p["name"],
                "position": p["pos"],
                "team": p["team"],
                "gsis_id": p.get("gsis"),
                "sleeper_id": p.get("sleeper"),
                "week": wk,
                "opp": game["opp"],
                "home": game["home"],
                "availability": p.get("avail"),
                "gp": p.get("gp"),
                "def_grade_pos": (opp_def.get("pos") or {}).get(p["pos"], {}).get("grade"),
                "def_grade_overall": (opp_def.get("overall") or {}).get("grade"),
                "matchup_mult": (pos_mult.get(p["team"], {}).get(p["pos"]) or [None] * 18)[i],
            }
            row.update(dict(zip(keys, line)))
            rows.append(row)
    df = pd.DataFrame(rows)
    if not df.empty:
        df["season"] = data.get("season")
        keymap = key_by_name_pos()
        df.insert(0, "player_key", [
            keymap.get((_norm(str(n)), str(p)))
            for n, p in zip(df["name"], df["position"])
        ])
    df.attrs["meta"] = {
        "generatedAt": data.get("generatedAt"),
        "note": data.get("note"),
    }
    df.attrs["dispersion"] = data.get("dispersion") or {}
    df.attrs["count_stats"] = data.get("countStats") or []
    df.attrs["defense"] = defense
    df.attrs["bye_weeks"] = data.get("byeWeeks") or {}
    df.attrs["stat_keys"] = stat_keys
    return df


def load_quarter_splits() -> Dict[str, Any]:
    """The raw rest-of-game reference: per-quarter shares (``share``,
    ``cumulative``, ``remaining``), game-script multipliers (``script``),
    in-game blend weights (``blend``) and partial-window spread
    (``dispersion``), plus team-level play/score/yard shares (``team``).

    Returned as the parsed document rather than a frame — it is a set of
    small lookup tables, not one rectangle. Use
    :func:`quarter_share_frame` for a tidy view of the shares.
    """
    return fetch_json(_SPLITS_PATH)


def quarter_share_frame(splits: Optional[Mapping[str, Any]] = None) -> pd.DataFrame:
    """Tidy view of the quarter shares: one row per (position, stat) with
    ``q1``-``q4`` shares and ``rest_after_q0``-``rest_after_q3``."""
    doc = splits if splits is not None else load_quarter_splits()
    rows = []
    for pos, stats in (doc.get("share") or {}).items():
        for stat, share in stats.items():
            rem = ((doc.get("remaining") or {}).get(pos) or {}).get(stat) or []
            row = {"position": pos, "stat": stat}
            row.update({f"q{i + 1}": v for i, v in enumerate(share)})
            row.update({f"rest_after_q{i}": v for i, v in enumerate(rem)})
            rows.append(row)
    return pd.DataFrame(rows)


def load_inseason_projections(season: int = 2025,
                             week: Optional[int] = None) -> pd.DataFrame:
    """Walk-forward in-season projections: what the model expected for week
    *w* knowing only weeks 1..w-1 of that season plus the prior season.

    This is the game-by-game counterpart to :func:`load_player_props`, which
    splits a preseason line across the schedule. Here every week is
    re-projected from what had actually happened by then, so it is what you
    would have had in hand on the Friday before kickoff.

    Columns: ``player_key``, ``name``, ``position``, ``team``, ``opp``,
    ``week``, ``home``, ``nGames`` (games of in-season history the projection
    had), plus one column per stat. Rows are conditional on the player
    appearing that week.

    Metadata on ``df.attrs``: ``meta`` (generatedAt + method note),
    ``params`` (the fitted stabilization constants) and ``params_meta``
    (which seasons those were fit on).
    """
    data = fetch_json(_INSEASON_PATH.format(season=season))
    stat_keys = data.get("statKeys") or {}
    rows = []
    for r in data.get("players") or []:
        if week is not None and r["week"] != week:
            continue
        row = {
            "name": r["name"], "position": r["pos"], "team": r["team"],
            "opp": r.get("opp"), "week": r["week"], "home": r.get("home"),
            "nGames": r.get("nGames"),
        }
        row.update(dict(zip(stat_keys.get(r["pos"]) or [], r["proj"])))
        rows.append(row)
    df = pd.DataFrame(rows)
    if not df.empty:
        df["season"] = data.get("season")
        keymap = key_by_name_pos()
        df.insert(0, "player_key", [
            keymap.get((_norm(str(n)), str(p)))
            for n, p in zip(df["name"], df["position"])
        ])
    df.attrs["meta"] = {"generatedAt": data.get("generatedAt"),
                        "note": data.get("note")}
    df.attrs["params"] = data.get("params") or {}
    df.attrs["params_meta"] = data.get("paramsMeta")
    df.attrs["stat_keys"] = stat_keys
    return df


def load_weekly_backtest(season: int = 2025) -> Dict[str, Any]:
    """How the in-season model scored against actuals and against external
    projections, for a season it was not fit on.

    Returned as the parsed document — it is a set of small metric tables, not
    one rectangle. Keys of interest: ``headToHeadPPR`` (MAE / RMSE / R2 /
    Spearman per model, by position), ``winRatePPR`` (share of player-weeks
    where the in-season model landed closer), ``byWeekBucket``,
    ``byPositionAndStat``, ``calibration`` (do N% props hit N%?) and
    ``sleeperProvenance``. See :func:`backtest_frame` for a tidy view.
    """
    return fetch_json(_BACKTEST_PATH.format(season=season))


def backtest_frame(backtest: Optional[Mapping[str, Any]] = None,
                   season: int = 2025) -> pd.DataFrame:
    """Tidy view of the headline backtest: one row per (position, model) with
    ``n``, ``mae``, ``rmse``, ``r2``, ``spearman`` and ``bias`` on PPR
    points."""
    doc = backtest if backtest is not None else load_weekly_backtest(season)
    rows = []
    for pos, models in (doc.get("headToHeadPPR") or {}).items():
        for model, m in (models or {}).items():
            if not m:
                continue
            rows.append({"position": pos, "model": model, **m})
    df = pd.DataFrame(rows)
    if not df.empty:
        df = df.sort_values(["position", "mae"]).reset_index(drop=True)
    return df


def script_bucket(score_diff: float) -> str:
    """Score-differential bucket label, from the offense's point of view."""
    if score_diff >= 15:
        return "lead15"
    if score_diff >= 9:
        return "lead9"
    if score_diff >= 4:
        return "lead4"
    if score_diff >= -3:
        return "close"
    if score_diff >= -8:
        return "trail4"
    if score_diff >= -14:
        return "trail9"
    return "trail15"


# ── pricing ───────────────────────────────────────────────────────────────

def price_props(player: str, week: int, stats: Optional[Sequence[str]] = None,
                position: Optional[str] = None) -> pd.DataFrame:
    """Every prop for one player-week: projected mean, line, over/under and
    p10-p90 range. Raises ``LookupError`` if the player isn't projected, and
    returns an empty frame if he is on bye that week.

    Columns: ``stat``, ``mean``, ``line``, ``over``, ``under``, ``p10``,
    ``p90``. ``df.attrs['anytime_td']`` carries P(at least one TD).
    """
    data = _props_doc()
    p = _find_player(data, player, position)
    keys = (data.get("statKeys") or {}).get(p["pos"]) or []
    row = (p.get("wk") or [None] * 18)[week - 1]
    if row is None:
        return pd.DataFrame(columns=["stat", "mean", "line", "over", "under", "p10", "p90"])
    line = dict(zip(keys, row))
    disp = (data.get("dispersion") or {}).get(p["pos"]) or {}
    count_stats = data.get("countStats") or []
    wanted = [s for s in (stats or keys) if s in line]
    out = [
        price_prop(s, line[s], disp.get(s), count_stats,
                   zero_prob=zero_prob_for_yards(s, line, disp))
        for s in wanted
    ]
    df = pd.DataFrame(out)
    tds = line.get("rushTD", 0) + line.get("recTD", 0)
    df.attrs["anytime_td"] = anytime_td_prob(tds) if tds > 0 else None
    df.attrs["player"] = {k: p[k] for k in ("name", "pos", "team") if k in p}
    df.attrs["availability"] = p.get("avail")
    return df


def rest_of_game(player: str, week: int, quarter: int,
                 score_diff: Optional[float] = None,
                 so_far: Optional[Mapping[str, float]] = None,
                 position: Optional[str] = None) -> pd.DataFrame:
    """Rest-of-game props standing at the end of a quarter.

        mu = remaining[q] * (w_pregame * full_game + w_in_game * pace_implied)
             * script[bucket]

    ``quarter`` is the quarter just completed (0 = pre-kickoff, 1-3).
    ``score_diff`` is his team's score minus the opponent's; omit it for no
    game-script adjustment, which is the right default before kickoff.
    ``so_far`` is what he already has this game, e.g.
    ``{"rec": 4, "recYds": 51}``.

    Columns: ``stat``, ``full_game``, ``so_far``, ``mean``, ``line``,
    ``over``, ``under``, ``p10``, ``p90``, ``remaining_share``,
    ``script_mult``, ``weight_in_game``.
    """
    data = _props_doc()
    splits = load_quarter_splits()
    p = _find_player(data, player, position)
    keys = (data.get("statKeys") or {}).get(p["pos"]) or []
    row = (p.get("wk") or [None] * 18)[week - 1]
    if row is None:
        return pd.DataFrame()
    full = dict(zip(keys, row))
    pos = p["pos"]
    bucket = None if score_diff is None else script_bucket(score_diff)
    script = (splits.get("script") or {}).get(bucket) or {} if bucket else {}
    blend = ((splits.get("blend") or {}).get(str(quarter)) or {}).get(pos) or {}
    disp_q = ((splits.get("dispersion") or {}).get(str(quarter)) or {}).get(pos) or {}
    disp_full = (data.get("dispersion") or {}).get(pos) or {}
    remaining = (splits.get("remaining") or {}).get(pos) or {}
    cumulative = (splits.get("cumulative") or {}).get(pos) or {}
    families = splits.get("scriptFamily") or {}
    count_stats = splits.get("countStats") or []

    means, meta = {}, {}
    for stat, full_mean in full.items():
        rem_row = remaining.get(stat)
        if not rem_row or quarter >= len(rem_row):
            continue
        rem = rem_row[quarter]
        w = blend.get(stat) or {"wSeason": 1.0, "wInGame": 0.0}
        cum = (cumulative.get(stat) or [0])[quarter - 1] if quarter > 0 else 0.0
        observed = (so_far or {}).get(stat)
        pace = observed / cum if cum > 0.02 and observed is not None else full_mean
        mult = script.get(families.get(stat), 1.0) if bucket else 1.0
        means[stat] = (w["wSeason"] * full_mean + w["wInGame"] * pace) * rem * mult
        meta[stat] = {"rem": rem, "mult": mult, "w_in_game": w["wInGame"]}

    disp_set = disp_q or disp_full
    rows = []
    for stat, mu in means.items():
        priced = price_prop(stat, mu, disp_q.get(stat) or disp_full.get(stat),
                            count_stats,
                            zero_prob=zero_prob_for_yards(stat, means, disp_set))
        rows.append({
            "stat": stat,
            "full_game": full[stat],
            "so_far": (so_far or {}).get(stat),
            "mean": priced["mean"],
            "line": priced["line"],
            "over": priced["over"],
            "under": priced["under"],
            "p10": priced["p10"],
            "p90": priced["p90"],
            "remaining_share": meta[stat]["rem"],
            "script_mult": meta[stat]["mult"],
            "weight_in_game": meta[stat]["w_in_game"],
        })
    df = pd.DataFrame(rows)
    tds = means.get("rushTD", 0) + means.get("recTD", 0)
    df.attrs["anytime_td"] = anytime_td_prob(tds) if tds > 0 else None
    df.attrs["bucket"] = bucket
    df.attrs["quarter"] = quarter
    return df


def _find_player(data: Mapping[str, Any], query: str,
                 position: Optional[str]) -> Dict[str, Any]:
    pool = [p for p in (data.get("players") or [])
            if not position or p["pos"] == position]
    q = _norm(query)
    for p in pool:
        if p.get("gsis") == query or p.get("sleeper") == query:
            return p
    for p in pool:
        if _norm(p["name"]) == q:
            return p
    for p in pool:
        if q in _norm(p["name"]):
            return p
    raise LookupError(f"no projected player matching {query!r}")
