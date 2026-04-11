#!/usr/bin/env python3
"""
Feature ablation for PPG models.

For each position's PPG model, train N+1 LOSO-CV models:
  1. A baseline model with all features
  2. N leave-one-out models, each missing exactly one feature

Report the marginal R² contribution of each feature:
  delta_R² = baseline_R² - ablated_R²

A positive delta means dropping the feature HURTS performance (important).
A negative delta means dropping the feature HELPS (dead weight or noise).
A delta near zero means the feature is redundant with others.

Usage:
    python3 scripts/ablate_ppg_features.py                # ablate all positions
    python3 scripts/ablate_ppg_features.py --pos RB       # just RB
    python3 scripts/ablate_ppg_features.py --pos RB --top 15  # only print top 15 features
"""

import json
import sys
import time
from pathlib import Path

import numpy as np
import lightgbm as lgb
from sklearn.linear_model import Ridge
from sklearn.metrics import r2_score
import warnings

warnings.filterwarnings('ignore')

DATA_DIR = Path('public/data')
CACHE_PATH = DATA_DIR / 'training-rows-cache-v42.json'
MODEL_CACHE_PATH = DATA_DIR / 'model-cache-ppg-v56.json'

# Must match train_ppg_models hyperparameters exactly.
LGB_PARAMS = {
    'objective': 'regression', 'metric': 'mae',
    'learning_rate': 0.05, 'max_depth': 3,
    'min_child_samples': 8, 'subsample': 0.8,
    'seed': 42, 'n_jobs': 1, 'verbose': -1,
}
N_ROUNDS = 100
RIDGE_ALPHA = 15
ENSEMBLE_GBM_WEIGHT = 0.7


def sf(v):
    if v is None or v == '' or v == 'NA' or v == 'NaN':
        return 0.0
    try:
        return float(v)
    except (ValueError, TypeError):
        return 0.0


def make_X(rows, keys):
    return np.array([[sf(r['features'].get(k, 0)) for k in keys] for r in rows])


def loso_r2(pos_rows, feature_names, y, seasons):
    """Run LOSO CV and return ensemble R² matching train_ppg_models."""
    X = make_X(pos_rows, feature_names)
    n = len(pos_rows)
    loso = np.zeros(n)

    for held in seasons:
        tr = [i for i, r in enumerate(pos_rows) if r['season'] != held]
        te = [i for i, r in enumerate(pos_rows) if r['season'] == held]
        if len(tr) < 10 or not te:
            continue
        # Ridge
        r_fold = Ridge(alpha=RIDGE_ALPHA)
        r_fold.fit(X[tr], y[tr])
        rp = r_fold.predict(X[te])
        # GBM
        dt = lgb.Dataset(X[tr], y[tr], feature_name=feature_names, free_raw_data=False)
        g_fold = lgb.train(LGB_PARAMS, dt, num_boost_round=N_ROUNDS)
        gp = g_fold.predict(X[te])
        # Blend
        for j, idx in enumerate(te):
            loso[idx] = gp[j] * ENSEMBLE_GBM_WEIGHT + rp[j] * (1 - ENSEMBLE_GBM_WEIGHT)

    return float(r2_score(y, loso))


def ablate_position(rows, pos_model, top=None):
    pos = pos_model['position']
    full_feats = pos_model['featureNames']
    pos_rows = [r for r in rows if r['position'] == pos and (r.get('adp') or 999) <= 250]
    y = np.array([sf(r.get('rawPPG', 0)) for r in pos_rows])
    seasons = sorted(set(r['season'] for r in pos_rows))

    print(f'\n{pos}: ablating {len(full_feats)} features on {len(pos_rows)} rows across {len(seasons)} seasons')

    # Baseline
    t0 = time.time()
    baseline_r2 = loso_r2(pos_rows, full_feats, y, seasons)
    base_time = time.time() - t0
    print(f'  Baseline R² = {baseline_r2:.4f}  (fold time: {base_time:.1f}s)')

    # Per-feature ablation
    results = []
    for i, drop_feat in enumerate(full_feats):
        ablated = [f for f in full_feats if f != drop_feat]
        r2_without = loso_r2(pos_rows, ablated, y, seasons)
        delta = baseline_r2 - r2_without
        results.append({
            'feature': drop_feat,
            'r2_without': round(r2_without, 4),
            'delta': round(delta, 4),
        })
        print(f'  [{i+1:>2}/{len(full_feats)}] {drop_feat:<28} without={r2_without:.4f}  Δ={delta:+.4f}')

    # Sort by importance (largest positive delta = most important)
    results.sort(key=lambda r: -r['delta'])

    print(f'\n  === {pos} Feature Importance (sorted by Δ R² when dropped) ===')
    print(f'  {"rank":<4} {"feature":<28} {"R²_w/o":<9} {"Δ":<10} {"verdict"}')
    shown = results if top is None else results[:top]
    for rank, r in enumerate(shown, 1):
        delta = r['delta']
        if delta > 0.01:
            verdict = 'IMPORTANT'
        elif delta > 0.002:
            verdict = 'useful'
        elif delta > -0.002:
            verdict = 'redundant'
        else:
            verdict = 'NOISE (dropping helps)'
        print(f'  {rank:<4} {r["feature"]:<28} {r["r2_without"]:<9.4f} {delta:+.4f}    {verdict}')

    return {
        'position': pos,
        'baseline': baseline_r2,
        'n': len(pos_rows),
        'nFeatures': len(full_feats),
        'results': results,
    }


def main():
    args = sys.argv[1:]
    pos_filter = None
    top = None
    if '--pos' in args:
        idx = args.index('--pos')
        if idx + 1 < len(args):
            pos_filter = args[idx + 1].upper()
    if '--top' in args:
        idx = args.index('--top')
        if idx + 1 < len(args):
            top = int(args[idx + 1])

    print(f'Loading training rows from {CACHE_PATH}...')
    # Use train_projection_models.load_rows() so the derived features
    # (priorPPG2yr, ageSquared, etc.) get computed consistently. Falls back
    # to raw JSON load if the import fails (e.g. script moved).
    try:
        sys.path.insert(0, str(Path(__file__).parent))
        from train_projection_models import load_rows as _load_rows_augmented  # type: ignore
        rows = _load_rows_augmented()
    except Exception as e:
        print(f'  (fallback to raw load: {e})')
        with open(CACHE_PATH) as f:
            rows = json.load(f)['rows']
    print(f'  {len(rows)} rows loaded')

    print(f'Loading PPG models from {MODEL_CACHE_PATH}...')
    with open(MODEL_CACHE_PATH) as f:
        cache = json.load(f)

    t0 = time.time()
    all_results = {}
    for pm in cache['ppgModels']:
        if pos_filter and pm['position'] != pos_filter:
            continue
        res = ablate_position(rows, pm, top=top)
        all_results[res['position']] = res

    elapsed = time.time() - t0

    # Cross-position summary
    print(f'\n{"=" * 70}')
    print('CROSS-POSITION SUMMARY: Top 5 most important features per position')
    print(f'{"=" * 70}')
    for pos, res in all_results.items():
        top5 = res['results'][:5]
        print(f'\n{pos} (baseline R²={res["baseline"]:.4f}, {res["nFeatures"]} features):')
        for r in top5:
            print(f'  {r["feature"]:<28} Δ={r["delta"]:+.4f}')

    print(f'\n{"=" * 70}')
    print('DEAD FEATURES (negative or near-zero Δ, candidates to prune)')
    print(f'{"=" * 70}')
    for pos, res in all_results.items():
        dead = [r for r in res['results'] if r['delta'] < 0.001]
        print(f'\n{pos}: {len(dead)} / {res["nFeatures"]} features with Δ < 0.001')
        for r in dead:
            tag = 'NOISE' if r['delta'] < -0.002 else 'redundant'
            print(f'  {r["feature"]:<28} Δ={r["delta"]:+.4f}  [{tag}]')

    # Save to disk for downstream tooling
    out_path = DATA_DIR / 'ppg-feature-ablation.json'
    with open(out_path, 'w') as f:
        json.dump({
            'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%S'),
            'positions': all_results,
        }, f, indent=2)
    print(f'\nResults saved to {out_path}')
    print(f'Total time: {elapsed:.1f}s')


if __name__ == '__main__':
    main()
