#!/usr/bin/env python3
"""Find the optimal per-position Clay/us projection blend from history.

For each past season it scores Clay's preseason projection and a point-in-time
prior-year-rates baseline (a stand-in for our model — see caveat) against the
ACTUAL season PPR from public/data/player_stats_<year>.csv.gz, then sweeps the
blend weight w in `w*Clay + (1-w)*baseline` per position.

Inputs are the extracted Clay JSONs produced by extract_clay_projections.py.
Historic player projections are committed under public/data (so they persist
across sessions without re-uploading the PDFs); the PDFs themselves stay out of
the repo. To process a brand-new historic PDF first:

    python3 scripts/extract_clay_projections.py <hist.pdf> <year> public/data/clay-projections-<year>.json
    python3 scripts/clay_blend_study.py --years 2021,2022,2023,2024,2025

Caveat: "baseline" is prior-year rates, not our full ensemble; our real model is
stronger, so the optimal Clay weights here are upper bounds.
"""
import argparse
import collections
import csv
import gzip
import json
import math
import random
import re
import unicodedata
from pathlib import Path

POS_SET = {"QB", "RB", "WR", "TE"}
RELEVANT_TOPN = {"QB": 24, "RB": 48, "WR": 60, "TE": 24}


def norm(n):
    n = unicodedata.normalize("NFKD", n).encode("ascii", "ignore").decode().lower()
    n = re.sub(r"\b(jr|sr|ii|iii|iv|v)\b", "", n)
    n = re.sub(r"[^a-z0-9 ]", "", n)
    return re.sub(r"\s+", " ", n).strip()


def clay_ppr(c):
    return (c.get("pass_yds", 0) * 0.04 + c.get("pass_td", 0) * 4 + c.get("pass_int", 0) * -2
            + c.get("rush_yds", 0) * 0.1 + c.get("rush_td", 0) * 6
            + c.get("rec", 0) * 1 + c.get("rec_yds", 0) * 0.1 + c.get("rec_td", 0) * 6)


def season_actuals(year):
    """name -> (season_ppr, games)."""
    ppr = collections.defaultdict(float)
    games = collections.defaultdict(int)
    with gzip.open(f"public/data/player_stats_{year}.csv.gz", "rt") as f:
        for r in csv.DictReader(f):
            if r.get("season_type") != "REG":
                continue
            n = norm(r["player_display_name"])
            try:
                ppr[n] += float(r["fantasy_points_ppr"] or 0)
            except ValueError:
                pass
            games[n] += 1
    return ppr, games


def baseline(year):
    """Point-in-time prior-year-rates projection: name -> projected season PPR."""
    hist = {}
    for y in (year - 1, year - 2, year - 3):
        try:
            hist[y] = season_actuals(y)
        except FileNotFoundError:
            pass
    wts = {year - 1: 0.6, year - 2: 0.3, year - 3: 0.1}
    out = {}
    names = set().union(*[set(p) for p, _ in hist.values()]) if hist else set()
    for n in names:
        num = den = 0.0
        g_last = 0
        for y, (p, g) in hist.items():
            if g.get(n, 0) >= 1:
                num += wts[y] * min(g[n], 17) / 17 * (p[n] / g[n])
                den += wts[y] * min(g[n], 17) / 17
                if y == year - 1:
                    g_last = g[n]
        if den > 0:
            exp_games = min(max(g_last, 12), 17) if g_last else 15
            out[n] = num / den * exp_games
    return out


def mae(pairs):
    return sum(abs(a - b) for a, b in pairs) / len(pairs)


def rmse(pairs):
    return math.sqrt(sum((a - b) ** 2 for a, b in pairs) / len(pairs))


def spearman(pairs):
    n = len(pairs)
    if n < 3:
        return 0.0
    def ranks(v):
        order = sorted(range(len(v)), key=lambda i: v[i])
        r = [0] * len(v)
        for rk, i in enumerate(order):
            r[i] = rk
        return r
    rx, ry = ranks([x for x, _ in pairs]), ranks([y for _, y in pairs])
    d2 = sum((rx[i] - ry[i]) ** 2 for i in range(n))
    return 1 - 6 * d2 / (n * (n * n - 1))


def sweep(rs, score, maximize, step=1):
    best_w, best = None, (-2 if maximize else 1e9)
    for i in range(0, 101, step):
        w = i / 100
        s = score([(w * c + (1 - w) * u, a) for c, u, a in rs])
        if (s > best) if maximize else (s < best):
            best, best_w = s, w
    return best_w, best


def bootstrap_ci(rs, score, maximize, n_boot=2000, ci=90, step=2):
    rng = random.Random(42)
    weights = []
    for _ in range(n_boot):
        sample = rng.choices(rs, k=len(rs))
        w, _ = sweep(sample, score, maximize, step=step)
        weights.append(w)
    weights.sort()
    lo = weights[int(n_boot * (100 - ci) / 200)]
    hi = weights[int(n_boot * (100 + ci) / 200)]
    return lo, hi


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clay-dir", default="public/data", help="dir of clay-projections-<year>.json")
    ap.add_argument("--years", required=True, help="comma list, e.g. 2021,2022,2023,2024,2025")
    ap.add_argument("--per-game", action="store_true", help="normalize to per-game PPR")
    ap.add_argument("--bootstrap", action="store_true", help="add 90%% bootstrap CIs")
    args = ap.parse_args()
    years = [int(y) for y in args.years.split(",")]

    rows = []  # (pos, year, clay_ppr, base_ppr, actual_ppr)
    for Y in years:
        clay = json.loads((Path(args.clay_dir) / f"clay-projections-{Y}.json").read_text())["players"]
        act, act_g = season_actuals(Y)
        base = baseline(Y)
        by_pos = collections.defaultdict(list)
        for c in clay:
            if c["position"] in POS_SET:
                by_pos[c["position"]].append(c)
        for p in POS_SET:
            for c in sorted(by_pos[p], key=lambda c: c.get("pos_rk", 999))[:RELEVANT_TOPN[p]]:
                n = norm(c["name"])
                if n in act and n in base:
                    cp = clay_ppr(c)
                    bp = base[n]
                    ap_val = act[n]
                    if args.per_game:
                        g = act_g.get(n, 17)
                        if g < 1:
                            continue
                        clay_g = c.get("games", 17) or 17
                        cp = cp / clay_g * g
                        ap_val = ap_val  # already actual total; normalize both to per-game
                        cp = clay_ppr(c) / clay_g
                        bp = bp / 17  # baseline assumes 17-game pace
                        ap_val = act[n] / g
                    rows.append((p, Y, cp, bp, ap_val))

    print(f"Seasons {years}: {len(rows)} non-rookie player-seasons")
    if args.per_game:
        print("(per-game PPR normalization)")
    print()

    metrics = [
        ("MAE (lower=better)", mae, False),
        ("RMSE (lower=better)", rmse, False),
        ("Spearman rank (higher=better)", spearman, True),
    ]

    for label, score, maximize in metrics:
        hdr = f"── Optimal Clay weight by {label} ──"
        print(hdr)
        ci_hdr = "   [90% CI]" if args.bootstrap else ""
        print(f"{'Pos':>4} {'n':>5} {'Clay':>7} {'Base':>7} {'best_w':>7} {'blend':>7} {'Δ':>7}{ci_hdr}")
        for p in ["QB", "RB", "WR", "TE", "ALL"]:
            rs = [(c, u, a) for (pp, _, c, u, a) in rows if p in (pp, "ALL")]
            cs = score([(c, a) for c, u, a in rs])
            us = score([(u, a) for c, u, a in rs])
            bw, bs = sweep(rs, score, maximize, step=1)
            if maximize:
                delta = bs - max(cs, us)
            else:
                delta = bs - min(cs, us)
            ci_str = ""
            if args.bootstrap and len(rs) >= 10:
                lo, hi = bootstrap_ci(rs, score, maximize)
                ci_str = f"   [{lo:.2f}-{hi:.2f}]"
            print(f"{p:>4} {len(rs):>5} {cs:>7.3f} {us:>7.3f} {bw:>7.2f} {bs:>7.3f} {delta:>+7.3f}{ci_str}")
        print()

    # Year-by-year stability table
    print("── Per-year optimal Clay weight (MAE) ──")
    print(f"{'Pos':>4}", end="")
    for y in years:
        print(f" {y:>6}", end="")
    print(f" {'5yr':>6}")
    for p in ["QB", "RB", "WR", "TE", "ALL"]:
        print(f"{p:>4}", end="")
        for y in years:
            rs = [(c, u, a) for (pp, yr, c, u, a) in rows if p in (pp, "ALL") and yr == y]
            if rs:
                bw, _ = sweep(rs, mae, False, step=5)
                print(f" {bw:>6.2f}", end="")
            else:
                print(f" {'--':>6}", end="")
        rs = [(c, u, a) for (pp, _, c, u, a) in rows if p in (pp, "ALL")]
        bw, _ = sweep(rs, mae, False, step=1)
        print(f" {bw:>6.2f}")
    print()

    print("── Per-year optimal Clay weight (Spearman) ──")
    print(f"{'Pos':>4}", end="")
    for y in years:
        print(f" {y:>6}", end="")
    print(f" {'5yr':>6}")
    for p in ["QB", "RB", "WR", "TE", "ALL"]:
        print(f"{p:>4}", end="")
        for y in years:
            rs = [(c, u, a) for (pp, yr, c, u, a) in rows if p in (pp, "ALL") and yr == y]
            if rs:
                bw, _ = sweep(rs, spearman, True, step=5)
                print(f" {bw:>6.2f}", end="")
            else:
                print(f" {'--':>6}", end="")
        rs = [(c, u, a) for (pp, _, c, u, a) in rows if p in (pp, "ALL")]
        bw, _ = sweep(rs, spearman, True, step=1)
        print(f" {bw:>6.2f}")
    print()

    # Recommendation
    print("── RECOMMENDED WEIGHTS ──")
    print("(Average of MAE-optimal and Spearman-optimal, 5yr aggregate)")
    for p in ["QB", "RB", "WR", "TE"]:
        rs = [(c, u, a) for (pp, _, c, u, a) in rows if pp == p]
        w_mae, _ = sweep(rs, mae, False, step=1)
        w_spear, _ = sweep(rs, spearman, True, step=1)
        w_rec = round((w_mae + w_spear) / 2, 2)
        print(f"  {p}: {w_rec:.2f}  (MAE→{w_mae:.2f}, Spearman→{w_spear:.2f})")


if __name__ == "__main__":
    main()
