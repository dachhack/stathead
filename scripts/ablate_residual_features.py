#!/usr/bin/env python3
"""
Feature ablation for residual models.

Residual models predict `rawPPG - (adp_sqrt_intercept + adp_sqrt_slope * sqrt(adp))`
— the deviation from a sqrt-ADP→PPG baseline. Their feature lists were
inherited from an old training cache and never hand-curated, so they're
full of candidate dead weight (combine measurables, redundant draft-pick
encodings, rookie-only features applied to veterans).

For each position, train N+1 LOSO-CV models matching train_residual_models
exactly:
  1. A baseline model with all features
  2. N leave-one-out models, each missing exactly one feature

Report the marginal R² contribution of each feature on the RESIDUAL target
(not on blended PPG). The residual target is recomputed per fold using the
fold's own ADP curve so the CV is honest end-to-end — same methodology as
train_residual_models after the PR-2 leakage fix.

Usage:
    python3 scripts/ablate_residual_features.py               # all positions
    python3 scripts/ablate_residual_features.py --pos RB      # just RB
    python3 scripts/ablate_residual_features.py --pos WR --top 20
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
MODEL_CACHE_PATH = DATA_DIR / 'model-cache-residual-v56.json'
OUTPUT_PATH = DATA_DIR / 'residual-feature-ablation.json'

sys.path.insert(0, str(Path(__file__).parent))
from train_projection_models import load_rows, sf  # type: ignore

# Per-position baselines MUST match train_residual_models::RESIDUAL_CONFIG
# exactly. Re-running ablation against a different config (e.g. a universal
# default that doesn't ship) produces meaningless marginal-Δ numbers.
# Source of truth: scripts/train_projection_models.py::RESIDUAL_CONFIG
RESIDUAL_CONFIG = {
    'QB': {'depth': 5, 'lr': 0.03, 'n_rounds': 100, 'min_leaf': 15, 'gbm_weight': 0.9},
    'RB': {'depth': 5, 'lr': 0.03, 'n_rounds': 100, 'min_leaf': 25, 'gbm_weight': 0.8},
    'WR': {'depth': 3, 'lr': 0.05, 'n_rounds': 100, 'min_leaf': 8,  'gbm_weight': 0.8},
    'TE': {'depth': 2, 'lr': 0.12, 'n_rounds': 100, 'min_leaf': 8,  'gbm_weight': 0.8},
}
RIDGE_ALPHA = 8


def make_X(rows, keys):
    return np.array([[sf(r['features'].get(k, 0)) for k in keys] for r in rows])


def loso_residual_r2(pos_rows, feature_names, cfg):
    """LOSO CV on the residual target, mirroring train_residual_models.

    Per-fold the ADP→PPG sqrt curve is refit on the training seasons,
    and the residual target is recomputed honestly for both train and test.
    Returns (cvR2Gbm, cvR2Ridge, cvR2Ensemble) on the residual target.

    cfg must match the per-position RESIDUAL_CONFIG so Δ values reflect
    real impact on the shipped model.
    """
    X = make_X(pos_rows, feature_names)
    y_ppg = np.array([sf(r.get('rawPPG', 0)) for r in pos_rows])
    adps = np.array([sf(r.get('adp', 999)) for r in pos_rows])
    n = len(pos_rows)
    seasons = sorted(set(r['season'] for r in pos_rows))

    loso_gbm = np.zeros(n)
    loso_ridge = np.zeros(n)
    y_residual_loso = np.zeros(n)
    valid = np.zeros(n, dtype=bool)

    lgb_params = {
        'objective': 'regression', 'metric': 'mae',
        'learning_rate': cfg['lr'], 'max_depth': cfg['depth'],
        'min_child_samples': cfg['min_leaf'], 'subsample': 0.8,
        'seed': 42, 'n_jobs': 1, 'verbose': -1,
    }

    for held in seasons:
        tr = [i for i, r in enumerate(pos_rows) if r['season'] != held]
        te = [i for i, r in enumerate(pos_rows) if r['season'] == held]
        if len(tr) < 15 or not te:
            continue
        # Per-fold ADP curve on training data — sqrt form, matches train_residual_models.
        adps_tr = adps[tr]
        y_ppg_tr = y_ppg[tr]
        valid_tr = adps_tr < 250
        if valid_tr.sum() >= 10:
            c = np.polyfit(np.sqrt(adps_tr[valid_tr]), y_ppg_tr[valid_tr], 1)
            s_tr, i_tr = float(c[0]), float(c[1])
        else:
            continue
        y_res_tr = y_ppg_tr - (i_tr + s_tr * np.sqrt(adps_tr))
        # Per-fold residual target for test rows (honest)
        for idx in te:
            y_residual_loso[idx] = y_ppg[idx] - (i_tr + s_tr * np.sqrt(adps[idx]))
            valid[idx] = True

        r_fold = Ridge(alpha=RIDGE_ALPHA)
        r_fold.fit(X[tr], y_res_tr)
        rp = r_fold.predict(X[te])
        dt = lgb.Dataset(X[tr], y_res_tr, feature_name=feature_names, free_raw_data=False)
        g_fold = lgb.train(lgb_params, dt, num_boost_round=cfg['n_rounds'])
        gp = g_fold.predict(X[te])
        for j, idx in enumerate(te):
            loso_gbm[idx] = gp[j]
            loso_ridge[idx] = rp[j]

    m = valid
    if m.sum() < 20:
        return 0.0, 0.0, 0.0
    gbm_r2 = float(r2_score(y_residual_loso[m], loso_gbm[m]))
    ridge_r2 = float(r2_score(y_residual_loso[m], loso_ridge[m]))
    gbm_w = cfg['gbm_weight']
    ens = gbm_w * loso_gbm + (1 - gbm_w) * loso_ridge
    ens_r2 = float(r2_score(y_residual_loso[m], ens[m]))
    return gbm_r2, ridge_r2, ens_r2


def ablate_position(rows, pos_model, top=None):
    pos = pos_model['position']
    cfg = RESIDUAL_CONFIG[pos]
    full_feats = pos_model['ridgeModel']['featureNames']
    pos_rows = [r for r in rows if r['position'] == pos and (r.get('adp') or 999) <= 250]

    print(f'\n{pos}: ablating {len(full_feats)} features on {len(pos_rows)} rows')
    print(f'  cfg: d={cfg["depth"]} lr={cfg["lr"]} n={cfg["n_rounds"]} mcs={cfg["min_leaf"]} gw={cfg["gbm_weight"]}')

    t0 = time.time()
    base_gbm, base_ridge, base_ens = loso_residual_r2(pos_rows, full_feats, cfg)
    base_time = time.time() - t0
    print(f'  Baseline: gbmR²={base_gbm:.4f} ridgeR²={base_ridge:.4f} ensR²={base_ens:.4f}  ({base_time:.1f}s)')

    results = []
    for i, drop_feat in enumerate(full_feats):
        ablated = [f for f in full_feats if f != drop_feat]
        gbm_r2, ridge_r2, ens_r2 = loso_residual_r2(pos_rows, ablated, cfg)
        delta = base_ens - ens_r2
        results.append({
            'feature': drop_feat,
            'gbmR2_without': round(gbm_r2, 4),
            'ensR2_without': round(ens_r2, 4),
            'delta': round(delta, 4),
        })
        print(f'  [{i+1:>2}/{len(full_feats)}] {drop_feat:<28} ensR²={ens_r2:.4f}  Δ={delta:+.4f}')

    results.sort(key=lambda r: -r['delta'])

    print(f'\n  === {pos} Feature Importance (sorted by Δ ens R² when dropped) ===')
    shown = results if top is None else results[:top]
    for rank, r in enumerate(shown, 1):
        delta = r['delta']
        if delta > 0.005:
            verdict = 'IMPORTANT'
        elif delta > 0.001:
            verdict = 'useful'
        elif delta > -0.001:
            verdict = 'redundant'
        else:
            verdict = 'NOISE (dropping helps)'
        print(f'  {rank:<4} {r["feature"]:<28} ensR²w/o={r["ensR2_without"]:.4f}  Δ={delta:+.4f}  {verdict}')

    return {
        'position': pos,
        'baseline_gbm': base_gbm,
        'baseline_ridge': base_ridge,
        'baseline_ens': base_ens,
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

    print(f'Loading training rows...')
    rows = load_rows()
    print(f'  {len(rows)} rows')

    print(f'Loading residual models from {MODEL_CACHE_PATH}...')
    with open(MODEL_CACHE_PATH) as f:
        cache = json.load(f)

    t0 = time.time()
    all_results = {}
    for rm in cache['residualModels']:
        if pos_filter and rm['position'] != pos_filter:
            continue
        res = ablate_position(rows, rm, top=top)
        all_results[res['position']] = res

    print(f'\n{"=" * 70}')
    print('DEAD FEATURES (Δ < 0.001, candidates to prune)')
    print(f'{"=" * 70}')
    for pos, res in all_results.items():
        dead = [r for r in res['results'] if r['delta'] < 0.001]
        print(f'\n{pos}: {len(dead)} / {res["nFeatures"]} features with Δ < 0.001')
        for r in dead:
            tag = 'NOISE' if r['delta'] < -0.001 else 'redundant'
            print(f'  {r["feature"]:<28} Δ={r["delta"]:+.4f}  [{tag}]')

    with open(OUTPUT_PATH, 'w') as f:
        json.dump({
            'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%S'),
            'residual_config': RESIDUAL_CONFIG,
            'ridge_alpha': RIDGE_ALPHA,
            'positions': all_results,
        }, f, indent=2)

    elapsed = time.time() - t0
    print(f'\nResults saved to {OUTPUT_PATH}')
    print(f'Total time: {elapsed:.1f}s')


if __name__ == '__main__':
    main()
