#!/usr/bin/env python3
"""Set our own pick lines for a week, the way a props book does.

For every QB / RB / WR / TE with a week stat line and real projected volume,
each stat's outcome distribution comes from the stat-line simulation of
scripts/score-weekly-projections.py (20,000 draws of the week line). The
line is the half-point nearest the simulation's MEDIAN (a book sets lines
at the median, not the mean; single games are right-skewed so the median
sits below the average), the two sides are priced at their share of draws,
and payouts are quoted fair (1 / p) and with a book's hold (HOLD, 11% like a
1.78x / 1.78x pair), so one side pays more where the median does not sit
cleanly on the half-point. The calibration shrink of price-lines.py is
applied to the side probabilities before pricing, since the raw shares run
hot.

Output: a markdown table (stdout) and, with --out, a JSON file of the lines
(data/our-lines/<season>-w<week>.json by default: committed, not deployed),
so a posted slate can be compared with ours and both graded against actuals.

Usage: python3 scripts/make-lines.py [--week 8] [--top 40] [--stat recYds,...]
       [--team DAL,PHI] [--min-vol] [--out data/our-lines/2026-w08.json]
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
from datetime import datetime, timezone

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'public', 'data')
_spec = importlib.util.spec_from_file_location('scorer', os.path.join(ROOT, 'scripts', 'score-weekly-projections.py'))
sc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sc)
_pl = importlib.util.spec_from_file_location('pricer', os.path.join(ROOT, 'scripts', 'price-lines.py'))
pl = importlib.util.module_from_spec(_pl)
_pl.loader.exec_module(pl)

DRAWS = 20000
HOLD = 0.124          # 1.78x / 1.78x -> 56.2% + 56.2% = 112.4%
STATS = {             # stat -> (positions, minimum projected volume stat, floor)
    'recYds': (('WR', 'TE', 'RB'), 'tgt', 3.0), 'rec': (('WR', 'TE', 'RB'), 'tgt', 3.0),
    'rushYds': (('RB', 'QB'), 'rushAtt', 6.0), 'rushAtt': (('RB',), 'rushAtt', 6.0),
    'passYds': (('QB',), 'passAtt', 20.0), 'passTD': (('QB',), 'passAtt', 20.0),
    'rushRecYds': (('RB',), 'rushAtt', 6.0), 'anyTD': (('RB', 'WR', 'TE'), None, 0.0),
}
INTEGER_STATS = {'rec', 'rushAtt', 'passTD', 'anyTD'}


def half_point(x):
    return float(np.floor(x)) + 0.5


def set_line(draws, stat):
    """The half-point nearest the median, with the raw and calibrated share
    of draws on each side, and payouts fair and with the hold."""
    med = float(np.median(draws))
    L = half_point(med)
    # For a lumpy integer stat the median may sit on an integer: pick the
    # half-point whose over share is closest to 50%.
    if stat in INTEGER_STATS:
        cands = [L - 1, L, L + 1]
        L = min((c for c in cands if c >= 0.5), key=lambda c: abs(float(np.mean(draws > c)) - 0.5))
    p_over = float(np.mean(draws > L))
    p_under = 1 - p_over
    cal = lambda p: 0.5 + pl.CAL_SHRINK * (p - 0.5)
    co, cu = cal(p_over), cal(p_under)
    fair = (1 / co, 1 / cu)
    book = ((1 / co) / (1 + HOLD), (1 / cu) / (1 + HOLD))
    return {'line': L, 'median': round(med, 1), 'pOverRaw': round(p_over, 3), 'pOver': round(co, 3), 'pUnder': round(cu, 3),
            'fairOver': round(fair[0], 2), 'fairUnder': round(fair[1], 2), 'bookOver': round(book[0], 2), 'bookUnder': round(book[1], 2)}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--season', type=int, default=2026)
    ap.add_argument('--week', type=int)
    ap.add_argument('--top', type=int, default=40, help='lines to print, by projected points (all go to --out)')
    ap.add_argument('--stat', default=','.join(STATS), help='comma-separated stats')
    ap.add_argument('--team', default=None, help='comma-separated teams')
    ap.add_argument('--out', default=None, help='JSON path (default data/our-lines/<season>-w<week>.json)')
    ap.add_argument('--no-out', action='store_true')
    args = ap.parse_args()
    now = datetime.now(timezone.utc)
    pr = pl.Pricer(args.season, args.week, now)
    week = pr.week
    stats = [s for s in args.stat.split(',') if s in STATS]
    teams = set(args.team.upper().split(',')) if args.team else None
    rows = []
    for p in sorted(pr.players, key=lambda p: -(p['wk'][week - 1] or 0)):
        if teams and p['team'] not in teams:
            continue
        if pl.status_for(p, week) in ('Out', 'IR', 'PUP', 'Sus', 'Doubtful', 'inactive'):
            continue
        wl, m = pl.week_line(p, week)
        params = (pr.bands.get('simulation') or {}).get('params', {}).get(p['pos'])
        if not wl or not params or (p['wk'][week - 1] or 0) < 4:
            continue
        rng = np.random.default_rng(int.from_bytes(f"{p['name']}|{week}".encode(), 'little') % (2 ** 32))
        d = sc.simulate_stats(wl, p['pos'], params, rng, DRAWS)
        for st in stats:
            poss, vol, floor = STATS[st]
            if p['pos'] not in poss or (vol and wl.get(vol, 0) < floor):
                continue
            comps = sc.PICK_STATS[st]
            if any(c not in d for c in comps):
                continue
            x = sum(d[c] for c in comps)
            if st == 'anyTD' and float(np.mean(x > 0.5)) < 0.25:
                continue
            r = {'week': week, 'player': p['name'], 'pos': p['pos'], 'team': p['team'], 'gsis': p.get('gsis'), 'sleeper': p.get('sleeper'),
                 'stat': st, 'proj': round(float(sum(wl.get(c, 0.0) for c in comps)), 1), 'pts': p['wk'][week - 1],
                 'status': pl.status_for(p, week), **set_line(x, st)}
            rows.append(r)
    print(f"Week {week} lines set {now.strftime('%Y-%m-%d %H:%M')} UTC: {len(rows)} lines on {len({r['player'] for r in rows})} players "
          f"(line = half-point nearest the simulation median; sides priced on the calibrated share; book payouts carry a {HOLD:.0%} hold).\n")
    print('| player | pos | stat | proj | median | line | P(over) | P(under) | fair O / U | book O / U |')
    print('|---|---|---|---|---|---|---|---|---|---|')
    for r in rows[:args.top]:
        print(f"| {r['player']} | {r['pos']} {r['team']} | {r['stat']} | {r['proj']} | {r['median']} | **{r['line']}** | {r['pOver']:.0%} | {r['pUnder']:.0%} | "
              f"{r['fairOver']:.2f} / {r['fairUnder']:.2f} | {r['bookOver']:.2f} / {r['bookUnder']:.2f} |")
    if not args.no_out:
        out = args.out or os.path.join(ROOT, 'data', 'our-lines', f'{args.season}-w{week:02d}.json')
        os.makedirs(os.path.dirname(out), exist_ok=True)
        json.dump({'season': args.season, 'week': week, 'setAt': now.isoformat(timespec='seconds'), 'hold': HOLD,
                   'calShrink': pl.CAL_SHRINK, 'note': 'StatHead-set pick lines: the half-point nearest the simulation median of '
                   'the week stat line, sides priced on the calibrated share of draws. Our own output; nothing third-party.',
                   'lines': rows}, open(out, 'w'), indent=1)
        print(f"\nwrote {len(rows)} lines to {os.path.relpath(out, ROOT)}", file=sys.stderr)


if __name__ == '__main__':
    main()
