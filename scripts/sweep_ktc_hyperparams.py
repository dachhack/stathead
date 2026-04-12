#!/usr/bin/env python3
"""Per-(position, horizon) hyperparameter sweep for the KTC time-series
model — Commit C.2b of the KTC reframe.

After Commit C.2a pruned features per-position, every (pos, H) model still
shares the same heavy-regularization config (max_depth=2, mcs=500, lr=0.03,
n=60, colsample=0.5, lambda_l2=5.0). That was the right pick for Commit A
when the goal was "every position gets a positive cvR²", but it caps the
headroom at the pairs where the data envelope and feature signal actually
allow more capacity.

This script runs a targeted grid search per (pos, H) using the same player-
grouped CV that the trainer uses as its primary long-horizon metric, and
writes the winning configs to public/data/ktc-hyperparam-sweep.json. The
trainer then reads that file via an LGB_PARAMS_PER_PAIR override dict
baked directly into train_ktc_timeseries.py.

Design notes:

  Metric = player-grouped pgR² only. Walk-forward is H ≤ 30 only, runs
  slower, and we already know from Commit A that for short horizons the
  two schemes agree within ±0.01 at reasonable configs. pgR² is the
  primary metric for long horizons and a secondary cross-check for short,
  so optimizing on it is aligned with the headline table.

  Grid = 48 configs per pair. Chosen to include the Commit C.2a baseline
  as an explicit grid point (max_depth=2, mcs=500, (lr=0.03, n=60),
  colsample=0.5, lambda_l2=5.0), so "no override" is a valid answer the
  sweep can return. Axes:

    max_depth:        [2, 3]                          (shallow vs slightly deeper)
    min_child_samples:[150, 300, 500]                 (less vs baseline)
    (lr, n_rounds):   [(0.03, 60), (0.05, 100)]       (slower-deeper vs faster-wider)
    colsample_bytree: [0.5, 0.8]                      (baseline vs looser)
    lambda_l2:        [3.0, 5.0]                      (mild decrease vs baseline)

    2 × 3 × 2 × 2 × 2 = 48 configs.

  Held fixed (across all configs):
    objective='regression', metric='mae',
    subsample=0.7, bagging_freq=1,
    seed=42, n_jobs=1.

  Why not sweep subsample / bagging_freq? Cross-run variance on those is
  dominated by the other dimensions at this sample size; including them
  would double the grid for ≤0.001 pgR² swings. Defer to a follow-up if
  any (pos, H) pair shows residual headroom.

  Why 5-fold CV in the sweep? The trainer already runs 5-fold player-
  grouped CV in ~1s per call. 48 × 20 × 1s ≈ 16 min total — worth the
  statistical stability over 3-fold (which would introduce per-fold
  variance on the order of the config differences we're trying to
  measure).

  Dataset caching. build_dataset is the expensive part of the trainer
  (~3s per pair × 20 pairs = 1 min). The sweep caches the assembled
  (X, y, pids, feature_names) tuples to a pickle keyed by the feature-
  list hash, so re-running the sweep (e.g. with a different grid) is
  near-instant.

Usage:
    source /tmp/lgb-verify/bin/activate
    python3 scripts/sweep_ktc_hyperparams.py            # full sweep
    python3 scripts/sweep_ktc_hyperparams.py --quick    # 3-fold CV,
                                                          smaller grid
"""
import hashlib
import itertools
import json
import os
import pickle
import sys
import time
from pathlib import Path

import numpy as np

# Reuse the trainer's module-level constants + functions rather than copy-
# pasting them. This keeps the sweep and the train loop on the same feature
# pipeline by construction.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from train_ktc_timeseries import (  # noqa: E402
    POSITIONS, HORIZONS,
    load_inputs,
    compute_fast_features_all, fill_rank_features, load_weekly_cache,
    build_dataset,
    player_grouped_cv,
    DROP_GLOBAL, DROP_PER_POS,
)
from train_projection_models import train_lgb_model  # noqa: E402,F401  (transitively used)

REPO_ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = REPO_ROOT / '.cache'
SWEEP_OUT = REPO_ROOT / 'public' / 'data' / 'ktc-hyperparam-sweep.json'

# ── Grid definition ─────────────────────────────────────────────────────

GRID_AXES = {
    'max_depth':         [2, 3],
    'min_child_samples': [150, 300, 500],
    'lr_n':               [(0.03, 60), (0.05, 100)],  # (learning_rate, n_rounds)
    'colsample_bytree':  [0.5, 0.8],
    'lambda_l2':         [3.0, 5.0],
}
FIXED_PARAMS = {
    'objective': 'regression',
    'metric': 'mae',
    'subsample': 0.7,
    'bagging_freq': 1,
    'seed': 42,
    'n_jobs': 1,
}

# Commit C.2a baseline — must appear in the grid as a concrete point so that
# "no override helps" is an expressible answer and its pgR² is measured by
# the same CV call (not compared against a stale Commit C.2a number).
BASELINE_CONFIG = {
    'max_depth': 2,
    'min_child_samples': 500,
    'lr_n': (0.03, 60),
    'colsample_bytree': 0.5,
    'lambda_l2': 5.0,
}


def enumerate_grid():
    """Return a list of config dicts covering the Cartesian product of
    GRID_AXES. Each dict is compact (axis → value) — conversion to the
    flat LightGBM params dict happens later."""
    keys = list(GRID_AXES.keys())
    vals = [GRID_AXES[k] for k in keys]
    return [dict(zip(keys, combo)) for combo in itertools.product(*vals)]


def config_to_lgb(cfg):
    """Expand a compact config into (lgb_params, n_rounds) for train_lgb_model."""
    lr, n_rounds = cfg['lr_n']
    params = {
        **FIXED_PARAMS,
        'learning_rate': lr,
        'max_depth': cfg['max_depth'],
        'min_child_samples': cfg['min_child_samples'],
        'colsample_bytree': cfg['colsample_bytree'],
        'lambda_l2': cfg['lambda_l2'],
    }
    return params, n_rounds


def config_key(cfg):
    """Stable sort/lookup key for a config dict."""
    return (cfg['max_depth'], cfg['min_child_samples'],
            cfg['lr_n'][0], cfg['lr_n'][1],
            cfg['colsample_bytree'], cfg['lambda_l2'])


def config_label(cfg):
    lr, nr = cfg['lr_n']
    return (f"md={cfg['max_depth']} mcs={cfg['min_child_samples']} "
            f"lr={lr} n={nr} col={cfg['colsample_bytree']} l2={cfg['lambda_l2']}")


# ── Dataset cache (pickled per-pair, keyed by feature-list hash) ────────

def _feature_fingerprint():
    """A short hash of the current feature config. Invalidates the on-disk
    dataset cache when the feature list changes."""
    from train_ktc_timeseries import (FAST_FEATURE_NAMES, SLOW_COMMON,
                                       SLOW_POS, WEEKLY_FEATURE_NAMES)
    payload = json.dumps({
        'fast': FAST_FEATURE_NAMES,
        'slow_common': SLOW_COMMON,
        'slow_pos': SLOW_POS,
        'weekly': WEEKLY_FEATURE_NAMES,
        'drop_global': sorted(DROP_GLOBAL),
        'drop_per_pos': {p: sorted(s) for p, s in DROP_PER_POS.items()},
    }, sort_keys=True).encode()
    return hashlib.sha1(payload).hexdigest()[:10]


def build_datasets_cached(verbose=True):
    """Build X/y/pids/fn_all for every (pos, H) pair once and pickle the
    result. Subsequent calls with the same feature fingerprint hit the
    cache and return in milliseconds."""
    CACHE_DIR.mkdir(exist_ok=True)
    fingerprint = _feature_fingerprint()
    cache_path = CACHE_DIR / f'ktc_datasets_{fingerprint}.pkl'

    if cache_path.exists():
        if verbose:
            print(f'[cache] hit: {cache_path.name}')
        with open(cache_path, 'rb') as f:
            return pickle.load(f)

    if verbose:
        print(f'[cache] miss → building (fingerprint={fingerprint})')
    t0 = time.time()
    players, slow_by_pid, date_grid = load_inputs()
    fast_by_pid = compute_fast_features_all(players)
    # fill_rank_features mutates fast_by_pid in place to add posRankPct +
    # posRankPctDelta_7d (they're cross-sectional so need date_grid access).
    fill_rank_features(players, fast_by_pid, date_grid)
    weekly_by_key, wcd = load_weekly_cache()
    if verbose:
        print(f'[cache]   load+fast+weekly: {time.time()-t0:.1f}s')

    datasets = {}
    for pos in POSITIONS:
        for horizon in HORIZONS:
            t1 = time.time()
            X, y, t, pids, fn_all = build_dataset(
                pos, horizon, players, fast_by_pid, slow_by_pid,
                weekly_by_key, wcd)
            datasets[(pos, horizon)] = {
                'X': X, 'y': y, 't': t, 'pids': pids, 'fn_all': fn_all,
            }
            if verbose:
                print(f'[cache]   {pos} H={horizon}: n={len(y)} cols={X.shape[1] if len(y) else 0} ({time.time()-t1:.1f}s)')

    with open(cache_path, 'wb') as f:
        pickle.dump(datasets, f)
    if verbose:
        print(f'[cache] wrote {cache_path.name} ({cache_path.stat().st_size/1e6:.1f} MB, total {time.time()-t0:.1f}s)')
    return datasets


# ── Sweep loop ──────────────────────────────────────────────────────────

def sweep_one_pair(pos, horizon, ds, grid, verbose=False):
    """Run every grid config on one (pos, H) dataset. Return a list of
    {config, pg_r2, pg_mae} sorted by pg_r2 descending."""
    X, y, pids, fn_all = ds['X'], ds['y'], ds['pids'], ds['fn_all']
    n = len(y)
    if n < 100:
        return []

    results = []
    for i, cfg in enumerate(grid):
        params, n_rounds = config_to_lgb(cfg)
        pg_r2, pg_mae, _, _ = player_grouped_cv(
            X, y, pids, fn_all, params, n_rounds, verbose_tag=None)
        results.append({
            'config': cfg,
            'pg_r2': float(pg_r2) if not np.isnan(pg_r2) else None,
            'pg_mae': float(pg_mae) if not np.isnan(pg_mae) else None,
        })
        if verbose and (i + 1) % 12 == 0:
            print(f'      [{pos}/H{horizon}] {i+1}/{len(grid)} configs done')
    # Sort by pg_r2 descending, NaN/None last
    results.sort(key=lambda r: r['pg_r2'] if r['pg_r2'] is not None else -1e9,
                 reverse=True)
    return results


def run_sweep(datasets, grid, verbose=True):
    t0 = time.time()
    out = {
        'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'featureFingerprint': _feature_fingerprint(),
        'gridAxes': {k: (list(v) if k != 'lr_n' else [list(t) for t in v])
                     for k, v in GRID_AXES.items()},
        'fixedParams': FIXED_PARAMS,
        'baselineConfig': {k: (list(v) if isinstance(v, tuple) else v)
                           for k, v in BASELINE_CONFIG.items()},
        'nConfigs': len(grid),
        'pairs': {},
    }
    for pos in POSITIONS:
        for horizon in HORIZONS:
            ds = datasets[(pos, horizon)]
            n = len(ds['y'])
            if n < 100:
                out['pairs'][f'{pos}_H{horizon}'] = None
                if verbose:
                    print(f'  {pos} H={horizon}: skipped (n={n})')
                continue
            t1 = time.time()
            ranked = sweep_one_pair(pos, horizon, ds, grid, verbose=verbose)
            dt = time.time() - t1

            # Find the baseline row by config_key match
            bkey = config_key(BASELINE_CONFIG)
            baseline_row = next((r for r in ranked
                                 if config_key(r['config']) == bkey), None)
            winner = ranked[0]
            win_r2 = winner['pg_r2'] if winner['pg_r2'] is not None else float('nan')
            base_r2 = (baseline_row['pg_r2'] if baseline_row and baseline_row['pg_r2'] is not None
                       else float('nan'))
            delta = (win_r2 - base_r2) if not (np.isnan(win_r2) or np.isnan(base_r2)) else float('nan')

            out['pairs'][f'{pos}_H{horizon}'] = {
                'position': pos,
                'horizon': horizon,
                'n': int(n),
                'baseline': {
                    'config': {k: (list(v) if isinstance(v, tuple) else v)
                               for k, v in BASELINE_CONFIG.items()},
                    'pg_r2': round(base_r2, 5) if not np.isnan(base_r2) else None,
                    'pg_mae': round(baseline_row['pg_mae'], 6) if (baseline_row and baseline_row['pg_mae'] is not None) else None,
                },
                'winner': {
                    'config': {k: (list(v) if isinstance(v, tuple) else v)
                               for k, v in winner['config'].items()},
                    'pg_r2': round(win_r2, 5) if not np.isnan(win_r2) else None,
                    'pg_mae': round(winner['pg_mae'], 6) if winner['pg_mae'] is not None else None,
                },
                'delta': round(delta, 5) if not np.isnan(delta) else None,
                'top5': [
                    {
                        'config': {k: (list(v) if isinstance(v, tuple) else v)
                                   for k, v in r['config'].items()},
                        'pg_r2': round(r['pg_r2'], 5) if r['pg_r2'] is not None else None,
                    }
                    for r in ranked[:5]
                ],
                'elapsed_sec': round(dt, 1),
            }
            if verbose:
                w = winner['config']
                bd_marker = ' ← baseline' if config_key(w) == bkey else ''
                print(f'  {pos} H={horizon}: base={base_r2:+.4f}  '
                      f'win={win_r2:+.4f}  Δ={delta:+.4f}  '
                      f'({config_label(w)}){bd_marker}  '
                      f'[{dt:.0f}s]')
    out['elapsed_sec'] = round(time.time() - t0, 1)
    return out


def main():
    quick = '--quick' in sys.argv

    datasets = build_datasets_cached(verbose=True)

    grid = enumerate_grid()
    if quick:
        # Quick mode: keep only the 2 most-impactful axes (max_depth,
        # min_child_samples) + the (lr, n) pair, hold colsample and
        # lambda_l2 at baseline. 12 configs instead of 48.
        grid = [c for c in grid
                if c['colsample_bytree'] == BASELINE_CONFIG['colsample_bytree']
                and c['lambda_l2'] == BASELINE_CONFIG['lambda_l2']]
        print(f'[grid] quick mode: {len(grid)} configs')
    else:
        print(f'[grid] full mode: {len(grid)} configs')

    out = run_sweep(datasets, grid, verbose=True)

    SWEEP_OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(SWEEP_OUT, 'w') as f:
        json.dump(out, f, indent=2)
    size_kb = SWEEP_OUT.stat().st_size / 1024
    print(f'\nWrote {SWEEP_OUT.relative_to(REPO_ROOT)} ({size_kb:.0f} KB)')
    print(f'Total sweep time: {out["elapsed_sec"]}s')

    # Summary: per-pair winner vs baseline
    print('\nSummary (winner vs Commit C.2a baseline):')
    net = 0.0
    wins = losses = 0
    for key, entry in out['pairs'].items():
        if entry is None:
            continue
        d = entry['delta']
        if d is None:
            continue
        net += d
        if d > 0.005:
            wins += 1
        elif d < -0.001:
            losses += 1
        marker = '✓' if d > 0.005 else '  '
        print(f'  {key:10s} n={entry["n"]:6d}  base={entry["baseline"]["pg_r2"]:+.4f}  '
              f'win={entry["winner"]["pg_r2"]:+.4f}  Δ={d:+.4f} {marker}')
    print(f'\nnet Δ sum: {net:+.4f}  wins (>+0.005): {wins}  losses: {losses}')


if __name__ == '__main__':
    main()
