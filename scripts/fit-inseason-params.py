#!/usr/bin/env python3
"""Fit the in-season model's constants — on seasons it will not be judged on.

Two things are fit here:

1. **Stabilization constants** (`k_*`, `half_life`, opponent shrinkage). These
   say how many games of evidence it takes before a player's own rate
   outweighs his prior. Fit by coordinate descent against a scale-free
   objective: the mean, over (position, stat) cells, of MAE divided by that
   cell's mean actual. Using normalized MAE stops passing yards (hundreds)
   from drowning out receptions (single digits).

2. **Prop calibration shifts.** The projected *mean* can be unbiased while the
   quoted *line* still sits on the wrong side of the median — real usage
   distributions are more right-skewed than the negative binomial the pricer
   assumes, so a "50%" target prop can hit 42% of the time. One logit shift
   per stat corrects that:  p_adj = sigmoid(logit(p) + b).  One parameter per
   stat, fit on thousands of player-weeks, is about as overfit-resistant as a
   correction gets.

Both are fit on the seasons given by `--fit-seasons` (2023 + 2024 by default)
and are meant to be evaluated on a season that was *not* in that set, so the
numbers in `weekly-backtest-2025.json` stay out of sample.

Usage:
  python3 scripts/fit-inseason-params.py [--fit-seasons 2023,2024]

Output:
  public/data/inseason-params.json
"""

import argparse
import importlib.util
import json
import math
import os
from collections import defaultdict
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'public', 'data')

_spec = importlib.util.spec_from_file_location(
    'inseason', os.path.join(ROOT, 'scripts', 'build-inseason-projections.py'))
IS = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(IS)

import sys
sys.path.insert(0, os.path.join(ROOT, 'python', 'src'))
from stathead.props import price_prop, zero_prob_for_yards  # noqa: E402

POSITIONS = IS.POSITIONS
COUNT_STATS = {'passAtt', 'passComp', 'passTD', 'int', 'rushAtt', 'rushTD',
               'tgt', 'rec', 'recTD'}
FIT_STATS = {
    'QB': ('passAtt', 'passYds', 'passTD', 'rushYds', 'pprPts'),
    'RB': ('rushAtt', 'rushYds', 'tgt', 'rec', 'recYds', 'pprPts'),
    'WR': ('tgt', 'rec', 'recYds', 'pprPts'),
    'TE': ('tgt', 'rec', 'recYds', 'pprPts'),
}

# Candidate values per constant, searched by coordinate descent.
GRID = {
    'half_life': [3.0, 4.0, 5.0, 7.0, 10.0, 14.0],
    'k_tgt_share': [0.5, 1.0, 1.5, 2.0, 3.0, 4.0],
    'k_rush_share': [0.5, 1.0, 1.5, 2.0, 3.0, 4.0],
    'k_pass_share': [0.1, 0.25, 0.5, 1.0, 1.5],
    'k_catch_rate': [6.0, 12.0, 20.0, 35.0, 60.0],
    'k_ypt': [8.0, 12.0, 20.0, 35.0, 60.0],
    'k_ypc': [1.0, 2.5, 5.0, 10.0, 20.0],
    'k_rec_td_rate': [14.0, 25.0, 40.0, 70.0, 120.0],
    'k_rush_td_rate': [8.0, 14.0, 25.0, 40.0, 70.0],
    'k_comp_pct': [3.0, 6.0, 12.0, 25.0],
    'k_ypa': [8.0, 16.0, 30.0, 60.0],
    'k_pass_td_rate': [12.0, 25.0, 50.0, 100.0],
    'k_int_rate': [14.0, 30.0, 60.0, 120.0],
    'k_team': [4.0, 8.0, 16.0, 32.0],
    'opp_shrink_vol': [0.0, 0.2, 0.35, 0.5, 0.7],
    'opp_shrink_eff': [0.0, 0.15, 0.25, 0.4, 0.6],
    'opp_blend_k': [1.0, 2.0, 4.0, 8.0],
    'home_mult': [1.0, 1.02, 1.04],
}


def load_actuals(season):
    actual = {}
    for r in IS.iter_csv_rows(f'player_stats_{season}'):
        if r.get('season_type') != 'REG' or r.get('position') not in POSITIONS:
            continue
        try:
            week = int(r.get('week') or 0)
        except ValueError:
            continue
        if 1 <= week <= IS.WEEKS:
            actual[(r.get('player_id'), week)] = {
                k: IS.num(r.get(c)) for k, c in IS.COLS.items()}
    return actual


def run_season(state, params, actual):
    """[(pos, stat, pred, actual, volume_happened)] for a whole season."""
    state.p = params
    rows = []
    volume_of = {'passYds': 'passAtt', 'rushYds': 'rushAtt', 'recYds': 'rec'}
    for week in range(1, IS.WEEKS + 1):
        for r in IS.project_week(state, week):
            act = actual.get((r['pid'], week))
            if act is None:
                continue
            keys = IS.STAT_KEYS[r['pos']]
            line = dict(zip(keys, r['proj']))
            for stat in keys:
                rows.append((r['pos'], stat, line[stat], act[stat],
                             act.get(volume_of.get(stat, stat), 0.0) > 0, line))
    return rows


def objective(rows):
    """Mean normalized MAE over the (position, stat) cells we care about."""
    acc = defaultdict(lambda: [0.0, 0.0, 0])
    for pos, stat, pred, act, _vol, _line in rows:
        if stat not in FIT_STATS.get(pos, ()):
            continue
        a = acc[(pos, stat)]
        a[0] += abs(pred - act)
        a[1] += act
        a[2] += 1
    vals = []
    for (_pos, _stat), (sae, sact, n) in acc.items():
        if n < 50 or sact <= 0:
            continue
        vals.append((sae / n) / (sact / n))
    return sum(vals) / len(vals) if vals else float('inf')


def fit_params(states, actuals, base, passes=2, verbose=True):
    best = dict(base)
    best_score = sum(objective(run_season(s, best, a))
                     for s, a in zip(states, actuals)) / len(states)
    if verbose:
        print(f'  start objective {best_score:.5f}')
    for p in range(passes):
        improved = False
        for key, values in GRID.items():
            for v in values:
                if v == best[key]:
                    continue
                trial = dict(best)
                trial[key] = v
                score = sum(objective(run_season(s, trial, a))
                            for s, a in zip(states, actuals)) / len(states)
                if score < best_score - 1e-6:
                    best_score, best, improved = score, trial, True
                    if verbose:
                        print(f'    pass {p + 1}: {key} -> {v}  ({score:.5f})')
        if not improved:
            break
    return best, best_score


def logit(p):
    p = min(max(p, 1e-6), 1 - 1e-6)
    return math.log(p / (1 - p))


def sigmoid(x):
    return 1 / (1 + math.exp(-x))


def fit_dispersion(rows):
    """Conditional spread of actual outcomes around the model's prediction.
    Yardage is fit on the games where the volume actually happened, because
    the pricer treats yardage as a zero-inflated mixture."""
    acc = defaultdict(lambda: {'smu': 0.0, 'smu2': 0.0, 'sse': 0.0, 'n': 0})
    for pos, stat, mu, act, vol, _line in rows:
        if mu <= 1e-6 or (stat not in COUNT_STATS and not vol):
            continue
        a = acc[(pos, stat)]
        a['smu'] += mu
        a['smu2'] += mu * mu
        a['sse'] += (act - mu) ** 2
        a['n'] += 1
    out = {}
    for (pos, stat), a in acc.items():
        if a['n'] < 50 or a['smu2'] <= 0:
            continue
        excess = a['sse'] - a['smu']
        k = (a['smu2'] / excess) if excess > 1e-6 else 50.0
        out.setdefault(pos, {})[stat] = {
            'k': round(min(max(k, 0.3), 50.0), 3),
            'cv': round(math.sqrt(a['sse'] / a['smu2']), 4),
            'n': a['n'],
        }
    return out


def fit_calibration(rows, disp):
    """stat -> logit shift that makes the mean stated over-probability match
    the realized over-rate. Solved by bisection; one parameter per stat."""
    obs = defaultdict(list)
    for pos, stat, mu, act, _vol, line in rows:
        if stat == 'pprPts' or mu <= 1e-6:
            continue
        d = (disp.get(pos) or {}).get(stat)
        if not d:
            continue
        priced = price_prop(stat, mu, d, COUNT_STATS,
                            zero_prob=zero_prob_for_yards(stat, line, disp[pos]))
        p = priced['over']
        if 0 < p < 1:
            obs[stat].append((p, 1 if act > priced['line'] else 0))
    shifts = {}
    for stat, pairs in obs.items():
        if len(pairs) < 200:
            continue
        target = sum(h for _p, h in pairs) / len(pairs)

        def mean_at(b):
            return sum(sigmoid(logit(p) + b) for p, _h in pairs) / len(pairs)

        lo, hi = -3.0, 3.0
        for _ in range(60):
            mid = (lo + hi) / 2
            if mean_at(mid) < target:
                lo = mid
            else:
                hi = mid
        shifts[stat] = {
            'shift': round((lo + hi) / 2, 4),
            'n': len(pairs),
            'rawMeanPredicted': round(sum(p for p, _h in pairs) / len(pairs), 4),
            'actualRate': round(target, 4),
        }
    return shifts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--fit-seasons', default='2023,2024')
    ap.add_argument('--passes', type=int, default=2)
    ap.add_argument('--skip-search', action='store_true',
                    help='keep the shipped constants, fit only the calibration')
    args = ap.parse_args()

    seasons = [int(s) for s in args.fit_seasons.split(',')]
    print(f'Fitting on {seasons} (evaluation seasons must not be in this list)')
    states, actuals = [], []
    for s in seasons:
        states.append(IS.SeasonState(s, dict(IS.PARAMS)))
        actuals.append(load_actuals(s))
        print(f'  {s}: {len(states[-1].rows)} player-weeks, '
              f'{len(states[-1].prior_rows)} prior-season rows')
        if not states[-1].prior_rows:
            raise SystemExit(f'No {s - 1} data — cannot fit {s} walk-forward.')

    if args.skip_search:
        params, score = dict(IS.PARAMS), sum(
            objective(run_season(s, dict(IS.PARAMS), a))
            for s, a in zip(states, actuals)) / len(states)
        print(f'  skipping search; objective {score:.5f}')
    else:
        params, score = fit_params(states, actuals, dict(IS.PARAMS), args.passes)
        print(f'  fitted objective {score:.5f}')

    rows = []
    for s, a in zip(states, actuals):
        rows.extend(run_season(s, params, a))
    disp = fit_dispersion(rows)
    calib = fit_calibration(rows, disp)

    out = {
        'fitSeasons': seasons,
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'note': (
            'Constants for the in-season weekly model, fit by coordinate '
            'descent on the seasons listed in fitSeasons against the mean '
            'normalized MAE (MAE / mean actual) across the (position, stat) '
            'cells in FIT_STATS. `calibration` holds one logit shift per stat '
            'applied to prop over-probabilities: the projected mean can be '
            'unbiased while the quoted line still sits on the wrong side of '
            'the median, because real usage is more right-skewed than the '
            'negative binomial the pricer assumes. Evaluate on a season not '
            'in fitSeasons.'
        ),
        'objective': round(score, 5),
        'params': params,
        'dispersion': disp,
        'calibration': calib,
    }
    path = os.path.join(DATA, 'inseason-params.json')
    with open(path, 'w') as f:
        json.dump(out, f, indent=1)
    print(f'Wrote {path}')
    changed = {k: (IS.PARAMS[k], v) for k, v in params.items() if IS.PARAMS[k] != v}
    print(f'  changed constants: {changed or "none"}')
    print('  calibration shifts (stat: shift, raw predicted -> actual):')
    for stat, c in sorted(calib.items()):
        print(f'    {stat:>9}  {c["shift"]:+.3f}   '
              f'{c["rawMeanPredicted"]:.3f} -> {c["actualRate"]:.3f}  (n={c["n"]})')


if __name__ == '__main__':
    main()
