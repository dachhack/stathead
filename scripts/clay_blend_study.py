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
    python3 scripts/clay_blend_study.py --clay-dir public/data --years 2023,2024,2026

Caveat: "baseline" is prior-year rates, not our full ensemble; our real model is
stronger, so the optimal Clay weights here are upper bounds. More seasons tighten
the estimates (QB/TE samples are thin with only 2 years).
"""
import argparse
import collections
import csv
import gzip
import json
import re
import unicodedata
from pathlib import Path

POS_SET = {"QB", "RB", "WR", "TE"}
RELEVANT_TOPN = {"QB": 24, "RB": 48, "WR": 60, "TE": 24}  # fantasy-relevant depth


def norm(n):
    n = unicodedata.normalize("NFKD", n).encode("ascii", "ignore").decode().lower()
    n = re.sub(r"\b(jr|sr|ii|iii|iv|v)\b", "", n)
    n = re.sub(r"[^a-z0-9 ]", "", n)
    return re.sub(r"\s+", " ", n).strip()


def clay_ppr(c):  # our PPR scoring on Clay's stat line (source-format agnostic)
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


def sweep(rs, score, maximize):
    best_w, best = None, (-2 if maximize else 1e9)
    for i in range(0, 101, 5):
        w = i / 100
        s = score([(w * c + (1 - w) * u, a) for c, u, a in rs])
        if (s > best) if maximize else (s < best):
            best, best_w = s, w
    return best_w, best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clay-dir", default="public/data", help="dir of clay-projections-<year>.json")
    ap.add_argument("--years", required=True, help="comma list, e.g. 2023,2024,2025")
    args = ap.parse_args()
    years = [int(y) for y in args.years.split(",")]

    rows = []
    for Y in years:
        clay = json.loads((Path(args.clay_dir) / f"clay-projections-{Y}.json").read_text())["players"]
        act, _ = season_actuals(Y)
        base = baseline(Y)
        by_pos = collections.defaultdict(list)
        for c in clay:
            if c["position"] in POS_SET:
                by_pos[c["position"]].append(c)
        for p in POS_SET:
            for c in sorted(by_pos[p], key=lambda c: c.get("pos_rk", 999))[:RELEVANT_TOPN[p]]:
                n = norm(c["name"])
                if n in act and n in base:  # need actual + prior data (non-rookie)
                    rows.append((p, clay_ppr(c), base[n], act[n]))

    print(f"Seasons {years}: {len(rows)} non-rookie player-seasons\n")
    for label, score, maximize in [("MAE (lower=better)", mae, False),
                                    ("Spearman rank (higher=better)", spearman, True)]:
        print(f"── Optimal Clay weight by {label} ──")
        print(f"{'Pos':>4} {'n':>4} {'Clay':>7} {'Base':>7} {'best_w':>7} {'blend':>7}")
        for p in ["QB", "RB", "WR", "TE", "ALL"]:
            rs = [(c, u, a) for (pp, c, u, a) in rows if p in (pp, "ALL")]
            cs = score([(c, a) for c, u, a in rs])
            us = score([(u, a) for c, u, a in rs])
            bw, bs = sweep(rs, score, maximize)
            print(f"{p:>4} {len(rs):>4} {cs:>7.3f} {us:>7.3f} {bw:>7.2f} {bs:>7.3f}")
        print()


if __name__ == "__main__":
    main()
