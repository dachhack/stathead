#!/usr/bin/env python3
"""Proxy back test of the weekly 3-pick bundles (scripts/build-pick-bundles.py).

No historical pick slates exist before week 7, so this rebuilds each week's
leans the way scripts/backtest-pick-lines.py does: the external benchmark
projection's own stat number, rounded to an app-style .5, stands in for the
line (receiving yards, rushing yards, passing yards, receptions); each
player-week is priced from StatHead's pre-kickoff stat line with the
simulation fitted on the weeks before (walk-forward from week 4; weeks 1-3
use the week-3 fit); P(lean) is calibrated with price-lines.py's CAL_SHRINK
and the payout is a flat --mult (1.78). A lean with edge 2%+ is a leg; the
real optimizer builds the week's bundles from them, and the box scores grade
them.

It reports, per week and in total: bundles, won against expected (the sum
of P(all 3)), the legs' hit rate against expected, and the return at a flat
payout of mult^3 per winning bundle (Sleeper sets its own entry payout, often
higher). Then the same for random valid bundles from the same legs (three
games, no shared leg or player), as a baseline for what the optimizing adds.

Caveats: the proxy line is a mean-set projection, so unders beat it more
often than they beat a median-set app line (backtest-pick-lines.py: 56% on
their own), and these leans carry none of the live guardrails (injury,
role, form flags). Read the totals as an upper bound and the
optimized-versus-random gap as the useful part.

Needs the weekly projection file's history in git (a full clone, or a
--filter=blob:none clone pointed at with GIT_DIR) and fetches the benchmark
projections into .cache/ on first run.

Usage:  [GIT_DIR=<clone>] python3 scripts/backtest-pick-bundles.py [--weeks 1-7] [--mult 1.78] [--random 500]
                                                             [--no-cap] [--calibration]
"""
import argparse
import importlib.util
import itertools
import json
import os
import sys
from collections import defaultdict
from datetime import datetime

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def mod(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, 'scripts', file))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


sc = mod('sc', 'score-weekly-projections.py')
bm = mod('bm', 'build-pick-bundles.py')
pl = mod('pl', 'price-lines.py')


def linear(raw):
    """The calibration before the cap (--no-cap), for comparison."""
    return 0.5 + pl.CAL_SHRINK * (raw - 0.5)

STATS = {'recYds': ('WR', 'TE', 'RB'), 'rushYds': ('RB', 'QB'), 'passYds': ('QB',), 'rec': ('WR', 'TE', 'RB')}
MIN_LINE = {'recYds': 15, 'rushYds': 15, 'passYds': 150, 'rec': 1.5}


def week_legs(season, weeks, mult, min_edge, cal=None):
    """{week: [leg]} priced as described in the module doc."""
    path = f'public/data/weekly-projections-{season}.json'
    kick = sc.kickoffs(season)
    act_stats = sc.load_actual_stats(season)
    srows, rows = [], []
    for w in weeks:
        commit, _ = sc.snapshot_before(path, kick[w])
        if not commit:
            print(f'week {w}: no pre-kickoff snapshot in git history', file=sys.stderr)
            continue
        snap = json.loads(sc.git('show', f'{commit}:{path}'))
        pool = sc.pool_lines_before(season, kick[w]) or {}
        sc.load_benchmark(season, w)             # caches the benchmark's raw file
        bench = sc.benchmark_stats(season, w) or {}
        for p in snap['players']:
            if p.get('pos') not in sc.POS or not p.get('gsis') or not p.get('ppg') or not p.get('wk'):
                continue
            proj = p['wk'][w - 1]
            sa = act_stats.get((p['gsis'], w))
            flat = p.get('statsPG') or pool.get((sc.norm_name(p['name']), p['pos']))
            if proj is None or not sa or not flat:
                continue
            line = sc.split_line(flat, p.get('statSplit'), proj / p['ppg'])
            srows.append({'w': w, 'pos': p['pos'], 'proj': line, 'act': sa})
            b = bench.get(str(p.get('sleeper') or ''))
            if b and p.get('status', 'ACT') == 'ACT':
                rows.append({'w': w, 'pos': p['pos'], 'name': p['name'], 'gsis': p['gsis'], 'team': p.get('team'),
                             'line': line, 'act': sa, 'bench': b})
    fit3 = sc.fit_sim_params([r for r in srows if r['w'] <= 3])
    fits = {w: (sc.fit_sim_params([r for r in srows if r['w'] < w]) if w >= 4 else None) or fit3 for w in weeks}
    legs = defaultdict(list)
    for r in rows:
        params = (fits.get(r['w']) or {}).get(r['pos'])
        if not params:
            continue
        d = sc.simulate_stats(r['line'], r['pos'], params, np.random.default_rng(1), 4000)
        for st, poss in STATS.items():
            if r['pos'] not in poss or st not in d:
                continue
            bl = r['bench'].get(st, 0.0)
            if bl < MIN_LINE[st] or r['line'].get(st, 0) <= 0:
                continue
            L = float(np.floor(bl) + 0.5)
            p_over = float(np.mean(d[st] > L))
            lean = 'over' if p_over > 0.5 else 'under'
            raw = max(p_over, 1 - p_over)
            p_lean = (cal or pl.calibrate)(raw)
            edge = p_lean - 1 / mult
            if edge < min_edge:
                continue
            a = r['act'].get(st, 0.0)
            legs[r['w']].append({'week': r['w'], 'player': r['name'], 'gsis': r['gsis'], 'team': r['team'], 'stat': st,
                                 'line': L, 'lean': lean, 'pLean': round(p_lean, 4), 'pRaw': round(raw, 4), 'mult': mult, 'edge': round(edge, 4),
                                 'flags': [], 'recordedAt': '', 'hit': (a > L) if lean == 'over' else (a < L)})
    return legs


def grade(bundles, mult):
    won = sum(1 for b in bundles if all(p['hit'] for p in b))
    exp = sum(float(np.prod([p['pLean'] for p in b])) for b in bundles)
    legs = [p for b in bundles for p in b]
    return {'n': len(bundles), 'won': won, 'expWon': exp,
            'legHits': sum(p['hit'] for p in legs), 'legs': len(legs), 'legExp': sum(p['pLean'] for p in legs),
            'ret': won * mult ** 3 - len(bundles)}


def random_bundles(cands, k, rng):
    """k random bundles under the optimizer's rules (three games, no shared
    leg or player); fewer if the legs run out."""
    pool = list(cands)
    rng.shuffle(pool)
    out = []
    while len(out) < k:
        found = None
        for combo in itertools.combinations(pool, 3):
            if len({p['_game'] for p in combo}) == 3 and len({p['gsis'] for p in combo}) == 3:
                found = combo
                break
        if not found:
            break
        out.append(found)
        used = {p['gsis'] for p in found}
        pool = [p for p in pool if p['gsis'] not in used]
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--season', type=int, default=2026)
    ap.add_argument('--weeks', default='1-7')
    ap.add_argument('--mult', type=float, default=1.78)
    ap.add_argument('--min-edge', type=float, default=bm.MIN_EDGE)
    ap.add_argument('--random', type=int, default=500, help='random bundle sets per week for the baseline')
    ap.add_argument('--no-cap', action='store_true', help='calibrate without CAL_CAP (the curve before 2026-11-02)')
    ap.add_argument('--calibration', action='store_true',
                    help='print hit rate by uncapped calibrated P over every lean (the table CAL_CAP was fitted on) and stop')
    args = ap.parse_args()
    a, b = (int(x) for x in args.weeks.split('-'))
    weeks = list(range(a, b + 1))
    if args.calibration:
        every = [p for w in week_legs(args.season, weeks, args.mult, -1.0, linear).values() for p in w]
        print(f'{len(every)} leans, weeks {a}-{b}: hit rate by uncapped calibrated P(lean)\n')
        print('| calibrated P | leans | hit rate | expected |\n|---|---|---|---|')
        for lo, hi in ((0.5, 0.54), (0.54, 0.58), (0.58, 0.6), (0.6, 0.62), (0.62, 0.65), (0.65, 0.68), (0.68, 0.71), (0.71, 1.0)):
            s = [p for p in every if lo <= p['pLean'] < hi]
            if s:
                print(f"| {lo:.0%}-{min(hi, 0.99):.0%} | {len(s)} | {np.mean([p['hit'] for p in s]):.1%} | {np.mean([p['pLean'] for p in s]):.1%} |")
        top = [p for p in every if p['pLean'] >= pl.CAL_CAP]
        print(f"\nAt {pl.CAL_CAP:.0%}+ (the cap): {len(top)} leans hit {np.mean([p['hit'] for p in top]):.1%}.")
        return
    legs = week_legs(args.season, weeks, args.mult, args.min_edge, linear if args.no_cap else None)
    rng = np.random.default_rng(7)
    tot, rtot = defaultdict(float), defaultdict(float)
    print(f'Proxy back test of the weekly 3-pick bundles, {args.season} weeks {a}-{b} '
          f'(flat {args.mult}x per leg, {args.mult ** 3:.2f}x per winning bundle; calibration '
          f"{'uncapped' if args.no_cap else f'capped at {pl.CAL_CAP:.0%}'})\n")
    print('| week | legs | bundles | won | expected | leg hits | leg expected | return (units) | random: won / expected / return |')
    print('|---|---|---|---|---|---|---|---|---|')
    for w in weeks:
        games = bm.games_by_team(args.season, w)
        cands = [{**p, '_game': games[p['team']][0]} for p in legs.get(w, []) if p['team'] in games]
        # One lean per player and stat (there is one), every game in play: as of the week's first kickoff.
        opt = bm.optimize(cands, bm.MAX_BUNDLES, bm.MIN_EV)
        g = grade(opt, args.mult)
        for k, v in g.items():
            tot[k] += v
        rs = [grade(random_bundles(cands, max(len(opt), 1), rng), args.mult) for _ in range(args.random)] if opt else []
        rmean = {k: float(np.mean([r[k] for r in rs])) for k in ('n', 'won', 'expWon', 'ret')} if rs else {'n': 0, 'won': 0, 'expWon': 0, 'ret': 0}
        for k, v in rmean.items():
            rtot[k] += v
        print(f"| {w} | {len(cands)} | {g['n']} | {g['won']} | {g['expWon']:.2f} | {g['legHits']}/{g['legs']} | "
              f"{g['legExp']:.1f} | {g['ret']:+.2f} | {rmean['won']:.2f} / {rmean['expWon']:.2f} / {rmean['ret']:+.2f} |")
    n = tot['n'] or 1
    print(f"| **all** | | **{tot['n']:.0f}** | **{tot['won']:.0f}** | **{tot['expWon']:.2f}** | "
          f"**{tot['legHits']:.0f}/{tot['legs']:.0f}** | **{tot['legExp']:.1f}** | **{tot['ret']:+.2f}** | "
          f"{rtot['won']:.2f} / {rtot['expWon']:.2f} / {rtot['ret']:+.2f} |")
    print(f"\nOptimized: {tot['won']:.0f} of {tot['n']:.0f} bundles won ({tot['won'] / n:.0%}) against {tot['expWon']:.1f} expected "
          f"({tot['expWon'] / n:.0%}); legs hit {tot['legHits'] / max(tot['legs'], 1):.1%} against "
          f"{tot['legExp'] / max(tot['legs'], 1):.1%} expected; return {tot['ret']:+.2f} units on {tot['n']:.0f} "
          f"({tot['ret'] / n:+.0%} per bundle).")
    rn = rtot['n'] or 1
    print(f"Random valid bundles from the same legs (mean of {args.random} draws a week): {rtot['won']:.1f} of {rtot['n']:.0f} "
          f"won ({rtot['won'] / rn:.0%}), expected {rtot['expWon']:.1f}; return {rtot['ret']:+.2f} ({rtot['ret'] / rn:+.0%} per bundle).")


if __name__ == '__main__':
    main()
