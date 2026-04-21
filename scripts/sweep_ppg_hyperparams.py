#!/usr/bin/env python3
"""
Per-position PPG hyperparameter sweep.

Current LGB_PARAMS in train_ppg_models were tuned for ~40 feature lists
(pre-pruning) and a fixed 0.7/0.3 GBM/Ridge ensemble blend. After pruning
to 14-22 features per position, those settings are likely no longer
optimal. This script does a focused grid search in 3 stages:

Stage 1: (max_depth, learning_rate) — holds n_rounds=100, min_leaf=8
Stage 2: (n_rounds, min_child_samples) — holds best (depth, lr) from Stage 1
Stage 3: ensemble_weight (GBM vs Ridge blend)

Each stage tests across 4 positions using LOSO CV identical to
train_ppg_models. Results are written to public/data/ppg-hyperparam-sweep.json
and the best config per position is printed at the end.

Usage:
    python3 scripts/sweep_ppg_hyperparams.py                # all positions
    python3 scripts/sweep_ppg_hyperparams.py --pos RB       # single position
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
CACHE_PATH = DATA_DIR / 'training-rows-cache-v49.json'
MODEL_CACHE_PATH = DATA_DIR / 'model-cache-ppg-v56.json'
OUTPUT_PATH = DATA_DIR / 'ppg-hyperparam-sweep.json'

# Use the same feature lists that train_ppg_models actually ships.
# These come from PPG_FEATURE_LISTS — we import them directly so the sweep
# always reflects the shipped model.
sys.path.insert(0, str(Path(__file__).parent))
from train_projection_models import load_rows, sf  # type: ignore

# Per-position baselines MUST match train_ppg_models::PPG_CONFIG exactly.
# If you change PPG_CONFIG in train_projection_models.py, update this dict
# and re-run the sweep. This is the same invariant the ablation script
# maintains — measuring sweep deltas against a baseline that doesn't
# match what ships makes the results meaningless.
# Source of truth: scripts/train_projection_models.py::PPG_CONFIG
PPG_BASELINE_CONFIG = {
    'QB': {'max_depth': 3, 'learning_rate': 0.08, 'n_rounds': 100, 'min_child_samples': 8,  'gbm_weight': 0.9},
    'RB': {'max_depth': 3, 'learning_rate': 0.08, 'n_rounds': 150, 'min_child_samples': 25, 'gbm_weight': 0.8},
    'WR': {'max_depth': 3, 'learning_rate': 0.12, 'n_rounds': 200, 'min_child_samples': 3,  'gbm_weight': 0.7},
    'TE': {'max_depth': 3, 'learning_rate': 0.05, 'n_rounds': 150, 'min_child_samples': 8,  'gbm_weight': 0.7},
}
RIDGE_ALPHA = 15  # matches train_ppg_models


def make_X(rows, keys):
    return np.array([[sf(r['features'].get(k, 0)) for k in keys] for r in rows])


def loso_r2(pos_rows, feats, lgb_params, n_rounds, ridge_alpha, gbm_weight):
    y = np.array([sf(r.get('rawPPG', 0)) for r in pos_rows])
    seasons = sorted(set(r['season'] for r in pos_rows))
    X = make_X(pos_rows, feats)
    n = len(pos_rows)
    loso = np.zeros(n)
    for held in seasons:
        tr = [i for i, r in enumerate(pos_rows) if r['season'] != held]
        te = [i for i, r in enumerate(pos_rows) if r['season'] == held]
        if len(tr) < 10 or not te:
            continue
        r_fold = Ridge(alpha=ridge_alpha)
        r_fold.fit(X[tr], y[tr])
        rp = r_fold.predict(X[te])
        dt = lgb.Dataset(X[tr], y[tr], feature_name=feats, free_raw_data=False)
        g_fold = lgb.train(lgb_params, dt, num_boost_round=n_rounds)
        gp = g_fold.predict(X[te])
        for j, idx in enumerate(te):
            loso[idx] = gp[j] * gbm_weight + rp[j] * (1 - gbm_weight)
    return float(r2_score(y, loso))


LGB_FIXED = {
    'objective': 'regression', 'metric': 'mae',
    'subsample': 0.8, 'seed': 42, 'n_jobs': 1, 'verbose': -1,
}


def sweep_position(rows, pos, feats, baseline_cfg):
    """Three-stage sweep around a per-position baseline.

    baseline_cfg must match train_ppg_models::PPG_CONFIG[pos] exactly so
    that the reported delta reflects real improvement over what ships.
    Stage 1 holds baseline's n_rounds and min_child_samples while sweeping
    depth × lr, so the current (depth, lr) is always present in the grid.
    Stage 2 holds best-so-far depth/lr while sweeping n_rounds × mcs.
    Stage 3 tunes GBM/Ridge blend weight.
    """
    pos_rows = [r for r in rows if r['position'] == pos and (r.get('adp') or 999) <= 250]
    print(f'\n{"=" * 70}')
    print(f'{pos}: {len(pos_rows)} rows, {len(feats)} features')
    print(f'  baseline config: {baseline_cfg}')
    print(f'{"=" * 70}')

    results = []

    def lgb_params_from(cfg):
        return {
            **LGB_FIXED,
            'learning_rate': cfg['learning_rate'],
            'max_depth': cfg['max_depth'],
            'min_child_samples': cfg['min_child_samples'],
        }

    # Baseline
    t0 = time.time()
    base_r2 = loso_r2(
        pos_rows, feats, lgb_params_from(baseline_cfg),
        baseline_cfg['n_rounds'], RIDGE_ALPHA, baseline_cfg['gbm_weight'],
    )
    base_time = time.time() - t0
    print(f'  BASELINE (= current shipping): R²={base_r2:.4f}  ({base_time:.1f}s)')
    results.append({'stage': 'baseline', 'params': dict(baseline_cfg), 'r2': base_r2})

    # ── Stage 1: depth × learning_rate ──
    # Hold baseline n_rounds + mcs so the current config is always in the grid.
    # Include a wider lr range so fast-learner configs get explored.
    print('\n  Stage 1: depth × learning_rate (holding baseline n_rounds, mcs)')
    depths = sorted({2, 3, 4, 5, baseline_cfg['max_depth']})
    lrs = sorted({0.03, 0.05, 0.08, 0.12, 0.18, baseline_cfg['learning_rate']})
    stage1 = []
    for depth in depths:
        for lr in lrs:
            cfg = {
                **baseline_cfg, 'max_depth': depth, 'learning_rate': lr,
            }
            r2 = loso_r2(
                pos_rows, feats, lgb_params_from(cfg),
                cfg['n_rounds'], RIDGE_ALPHA, cfg['gbm_weight'],
            )
            stage1.append({'depth': depth, 'lr': lr, 'r2': r2})
            results.append({'stage': 'stage1', 'params': dict(cfg), 'r2': r2})
            marker = ' ★' if r2 > base_r2 else ''
            print(f'    depth={depth} lr={lr:.3f}  R²={r2:.4f}  Δ={r2-base_r2:+.4f}{marker}')

    best_s1 = max(stage1, key=lambda x: x['r2'])
    print(f'  → Best stage 1: depth={best_s1["depth"]} lr={best_s1["lr"]}  R²={best_s1["r2"]:.4f}')

    # ── Stage 2: n_rounds × min_child_samples ──
    # Hold best-so-far depth and lr.
    print('\n  Stage 2: n_rounds × min_child_samples (holding best depth, lr)')
    rounds_grid = sorted({60, 100, 150, 200, 300, baseline_cfg['n_rounds']})
    mcs_grid = sorted({3, 5, 8, 15, 25, baseline_cfg['min_child_samples']})
    stage2 = []
    for n_rounds in rounds_grid:
        for mcs in mcs_grid:
            cfg = {
                **baseline_cfg,
                'max_depth': best_s1['depth'],
                'learning_rate': best_s1['lr'],
                'n_rounds': n_rounds,
                'min_child_samples': mcs,
            }
            r2 = loso_r2(
                pos_rows, feats, lgb_params_from(cfg),
                n_rounds, RIDGE_ALPHA, cfg['gbm_weight'],
            )
            stage2.append({'n_rounds': n_rounds, 'mcs': mcs, 'r2': r2})
            results.append({'stage': 'stage2', 'params': dict(cfg), 'r2': r2})
            marker = ' ★' if r2 > base_r2 else ''
            print(f'    n_rounds={n_rounds:>3} mcs={mcs:>2}  R²={r2:.4f}  Δ={r2-base_r2:+.4f}{marker}')

    best_s2 = max(stage2, key=lambda x: x['r2'])
    print(f'  → Best stage 2: n_rounds={best_s2["n_rounds"]} mcs={best_s2["mcs"]}  R²={best_s2["r2"]:.4f}')

    # ── Stage 3: ensemble weight (hold best everything) ──
    print('\n  Stage 3: ensemble weight')
    stage3 = []
    best_hyper = {
        **baseline_cfg,
        'max_depth': best_s1['depth'],
        'learning_rate': best_s1['lr'],
        'n_rounds': best_s2['n_rounds'],
        'min_child_samples': best_s2['mcs'],
    }
    weights_grid = sorted({0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, baseline_cfg['gbm_weight']})
    for gbm_w in weights_grid:
        cfg = {**best_hyper, 'gbm_weight': gbm_w}
        r2 = loso_r2(
            pos_rows, feats, lgb_params_from(cfg),
            cfg['n_rounds'], RIDGE_ALPHA, gbm_w,
        )
        stage3.append({'gbm_weight': gbm_w, 'r2': r2})
        results.append({'stage': 'stage3', 'params': dict(cfg), 'r2': r2})
        marker = ' ★' if r2 > base_r2 else ''
        print(f'    gbm_w={gbm_w:.1f}  R²={r2:.4f}  Δ={r2-base_r2:+.4f}{marker}')

    # Final best
    best_result = max(results, key=lambda r: r['r2'])
    delta = best_result['r2'] - base_r2
    print(f'\n  WINNER: stage={best_result["stage"]} params={best_result["params"]}')
    print(f'          R²={best_result["r2"]:.4f}  Δ vs shipping={delta:+.4f}')

    return {
        'position': pos,
        'n': len(pos_rows),
        'features': len(feats),
        'baseline_r2': base_r2,
        'best_r2': best_result['r2'],
        'best_params': best_result['params'],
        'delta': delta,
        'all_results': results,
    }


def get_ppg_feature_lists_from_script():
    """Extract the shipped PPG_FEATURE_LISTS by reading model-cache-ppg-v56.json.

    (We can't import train_ppg_models directly because the dict is defined
    inside the function body, but the saved cache has the same feature names.)
    """
    with open(MODEL_CACHE_PATH) as f:
        cache = json.load(f)
    return {m['position']: m['featureNames'] for m in cache['ppgModels']}


def main():
    args = sys.argv[1:]
    pos_filter = None
    if '--pos' in args:
        idx = args.index('--pos')
        if idx + 1 < len(args):
            pos_filter = args[idx + 1].upper()

    print(f'Loading rows with derived features...')
    rows = load_rows()
    print(f'  {len(rows)} rows')

    feature_lists = get_ppg_feature_lists_from_script()

    t_start = time.time()
    all_results = {}
    for pos in ['QB', 'RB', 'WR', 'TE']:
        if pos_filter and pos != pos_filter:
            continue
        feats = feature_lists.get(pos, [])
        if not feats:
            continue
        result = sweep_position(rows, pos, feats, PPG_BASELINE_CONFIG[pos])
        all_results[pos] = result

    elapsed = time.time() - t_start

    print(f'\n{"=" * 70}')
    print('SWEEP SUMMARY (baseline = current shipping per-position PPG_CONFIG)')
    print(f'{"=" * 70}')
    print(f'{"pos":<4} {"baseline":<10} {"best":<10} {"Δ":<10} best params')
    for pos, r in all_results.items():
        p = r['best_params']
        p_str = f'd={p.get("max_depth","-")} lr={p.get("learning_rate","-")} n={p.get("n_rounds","-")} mcs={p.get("min_child_samples","-")} w={p.get("gbm_weight","-")}'
        print(f'{pos:<4} {r["baseline_r2"]:<10.4f} {r["best_r2"]:<10.4f} {r["delta"]:+.4f}  {p_str}')

    with open(OUTPUT_PATH, 'w') as f:
        json.dump({
            'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%S'),
            'baseline': PPG_BASELINE_CONFIG,
            'ridge_alpha': RIDGE_ALPHA,
            'positions': all_results,
        }, f, indent=2)

    print(f'\nResults written to {OUTPUT_PATH}')
    print(f'Total time: {elapsed:.1f}s')


if __name__ == '__main__':
    main()
