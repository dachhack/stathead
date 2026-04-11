#!/usr/bin/env python3
"""
Train all StatHead models using Python (LightGBM + scikit-learn).

Replaces the JavaScript training pipeline with 50-100x faster Python.
Outputs JSON model caches in the exact format the TypeScript site expects,
so no browser-side code changes are needed.

Model types trained:
  1. ADP models (per-position PPG from ADP features)
  2. PPG models (ADP-free PPG prediction)
  3. Residual models (ADP residual = where ADP is wrong)
  4. Share models (player share of team volume, 15+ sub-models)
  5. Career models (rookie career best-2-of-3, pre-draft + post-draft)

Usage:
  python3 scripts/train_all_models.py                    # train everything
  python3 scripts/train_all_models.py --only career      # just career models
  python3 scripts/train_all_models.py --only adp,ppg     # specific types
"""

import json
import sys
import time
import math
import numpy as np
import lightgbm as lgb
from sklearn.linear_model import Ridge
from sklearn.metrics import r2_score, mean_absolute_error
from scipy.stats import spearmanr
from pathlib import Path


# ── Paths ───────────────────────────────────────────────────────────
DATA_DIR = Path('public/data')
CACHE_PATH = DATA_DIR / 'training-rows-cache-v42.json'

CACHE_PATHS = {
    'adp':             DATA_DIR / 'model-cache-adp-v56.json',
    'ppg':             DATA_DIR / 'model-cache-ppg-v56.json',
    'residual':        DATA_DIR / 'model-cache-residual-v56.json',
    'share':           DATA_DIR / 'model-cache-share-v56.json',
    'career':          DATA_DIR / 'model-cache-career-v69.json',
    'career_postdraft': DATA_DIR / 'model-cache-career-postdraft-v1.json',
}


# ── LightGBM → JS GBM tree conversion ──────────────────────────────
# The TypeScript site expects trees in our custom format:
#   { featureIndex, threshold, value, left, right }
# LightGBM outputs a different structure. We convert.

def lgb_tree_to_js(tree_info: dict, feature_names: list[str]) -> dict:
    """Convert a single LightGBM tree to JS-compatible format."""
    tree_structure = tree_info['tree_structure']
    return _convert_node(tree_structure, feature_names)


def _convert_node(node: dict, feature_names: list[str]) -> dict:
    """Recursively convert LightGBM node to JS format."""
    if 'leaf_value' in node:
        # Leaf node
        return {
            'featureIndex': -1,
            'threshold': 0,
            'value': round(node['leaf_value'], 10),
            'left': None,
            'right': None,
        }

    # Internal node
    split_feature = node['split_feature']
    threshold = node['threshold']

    # LightGBM uses "decision_type": "<=", meaning left child is <= threshold
    left = _convert_node(node['left_child'], feature_names)
    right = _convert_node(node['right_child'], feature_names)

    return {
        'featureIndex': split_feature,
        'threshold': threshold,
        'value': 0,
        'left': left,
        'right': right,
    }


def lgb_model_to_js(model: lgb.Booster, feature_names: list[str],
                     X_train: np.ndarray, y_train: np.ndarray) -> dict:
    """Convert a trained LightGBM model to JS-compatible GBM format.

    See scripts/train_projection_models.py::lgb_to_js_gbm for the full
    explanation of why initialPrediction=0 and learningRate=1 are correct:
    LightGBM bakes shrinkage and boost_from_average init directly into the
    leaf_values returned by dump_model().

    NOTE: This file is currently orphaned (not called from CI, npm, or any
    active script) but still reachable via manual `python3 scripts/train_all_models.py`.
    Keeping the converter consistent with train_projection_models.py to avoid
    a dormant footgun.
    """
    dump = model.dump_model()
    trees = []
    for tree_info in dump['tree_info']:
        trees.append(lgb_tree_to_js(tree_info, feature_names))

    # Compute in-sample metrics
    preds = model.predict(X_train)
    r2 = float(r2_score(y_train, preds))
    mae = float(mean_absolute_error(y_train, preds))
    rmse = float(np.sqrt(np.mean((y_train - preds) ** 2)))
    n = len(y_train)

    return {
        'trees': trees,
        'initialPrediction': 0.0,  # baked into leaf_values by LightGBM
        'learningRate': 1.0,       # baked into leaf_values by LightGBM
        'featureNames': feature_names,
        'rSquared': round(r2, 6),
        'adjustedRSquared': round(1 - (1 - r2) * (n - 1) / max(1, n - len(feature_names) - 1), 6),
        'mae': round(mae, 4),
        'rmse': round(rmse, 4),
        'n': n,
        'predictions': [round(float(p), 4) for p in preds],
        'loss': 'squared',
    }


def train_ridge_to_js(X: np.ndarray, y: np.ndarray, feature_names: list[str],
                       alpha: float) -> dict:
    """Train Ridge regression and output JS-compatible format."""
    # Standardize features (matching JS ridge.ts behavior)
    means = np.nanmean(X, axis=0)
    stds = np.nanstd(X, axis=0)
    stds[stds == 0] = 1  # avoid division by zero
    X_std = (X - means) / stds

    target_mean = float(np.mean(y))
    target_std = float(np.std(y))
    if target_std == 0:
        target_std = 1
    y_std = (y - target_mean) / target_std

    ridge = Ridge(alpha=alpha, fit_intercept=True)
    ridge.fit(X_std, y_std)

    # Predictions in standardized space, then destandardize
    preds_std = ridge.predict(X_std)
    preds = preds_std * target_std + target_mean

    r2 = float(r2_score(y, preds))
    mae = float(mean_absolute_error(y, preds))
    rmse = float(np.sqrt(np.mean((y - preds) ** 2)))
    n = len(y)

    return {
        'coefficients': [round(float(c), 10) for c in ridge.coef_],
        'intercept': target_mean,  # JS uses targetMean as intercept
        'featureNames': feature_names,
        'featureMeans': [round(float(m), 10) for m in means],
        'featureStds': [round(float(s), 10) for s in stds],
        'targetMean': target_mean,
        'targetStd': target_std,
        'rSquared': round(r2, 6),
        'adjustedRSquared': round(1 - (1 - r2) * (n - 1) / max(1, n - len(feature_names) - 1), 6),
        'mae': round(mae, 4),
        'rmse': round(rmse, 4),
        'n': n,
        'predictions': [round(float(p), 4) for p in preds],
    }


# ── Shared helpers ──────────────────────────────────────────────────

def load_training_rows():
    """Load training rows from cache."""
    with open(CACHE_PATH) as f:
        data = json.load(f)
    return data['rows']


def make_X(rows: list, feature_keys: list[str]) -> np.ndarray:
    """Build feature matrix from rows."""
    return np.array([[r['features'].get(k, 0) or 0 for k in feature_keys] for r in rows])


def make_y(rows: list, target_key: str) -> np.ndarray:
    """Extract target variable."""
    return np.array([r.get(target_key, 0) or 0 for r in rows])


def get_seasons(rows: list) -> list[int]:
    """Get sorted unique seasons."""
    return sorted(set(r['season'] for r in rows))


def train_lgb(X: np.ndarray, y: np.ndarray, feature_names: list[str],
              params: dict, n_rounds: int) -> lgb.Booster:
    """Train a single LightGBM model."""
    dtrain = lgb.Dataset(X, y, feature_name=feature_names, free_raw_data=False)
    return lgb.train({**params, 'verbose': -1}, dtrain, num_boost_round=n_rounds)


def train_bagged_lgb(X: np.ndarray, y: np.ndarray, feature_names: list[str],
                     params: dict, n_rounds: int, n_bags: int = 5) -> list[lgb.Booster]:
    """Train bagged LightGBM ensemble."""
    models = []
    for i in range(n_bags):
        p = {**params, 'seed': 42 + i, 'bagging_fraction': 0.8, 'bagging_freq': 1}
        models.append(train_lgb(X, y, feature_names, p, n_rounds))
    return models


def predict_bagged(models: list[lgb.Booster], X: np.ndarray) -> np.ndarray:
    """Average predictions from bagged ensemble."""
    return np.mean([m.predict(X) for m in models], axis=0)


# ── Import career model training ────────────────────────────────────
# Reuse the career model script (already Python)
sys.path.insert(0, str(Path(__file__).parent))


def main():
    args = sys.argv[1:]
    only = None
    if '--only' in args:
        idx = args.index('--only')
        if idx + 1 < len(args):
            only = set(args[idx + 1].split(','))

    rows = load_training_rows()
    print(f'Loaded {len(rows)} training rows')

    total_start = time.time()

    # ── 1. Career Models ────────────────────────────────────────────
    if only is None or 'career' in only:
        from train_career_models import build_career_rows, train_position
        from train_career_models import PRE_DRAFT_FEATURES, POST_DRAFT_FEATURES

        career_rows = build_career_rows(rows)
        print(f'\n{"="*60}')
        print(f'CAREER MODELS ({len(career_rows)} career rows)')
        print(f'{"="*60}')

        # Pre-draft
        pre_draft = {}
        print('\n  Pre-draft:')
        for pos in ['QB', 'RB', 'WR', 'TE']:
            feats = PRE_DRAFT_FEATURES.get(pos, [])
            result = train_position(career_rows, pos, feats, is_post_draft=False)
            if result:
                pre_draft[pos] = result
                print(f'    {pos}: n={result["n"]}, R²={result["cvR2"]:.3f}, MAE={result["cvMAE"]:.1f}')

        with open(CACHE_PATHS['career'], 'w') as f:
            json.dump({'rookieCareerModels': pre_draft}, f)
        print(f'  Saved: {CACHE_PATHS["career"]}')

        # Post-draft
        post_draft = {}
        print('\n  Post-draft:')
        for pos in ['QB', 'RB', 'WR', 'TE']:
            feats = POST_DRAFT_FEATURES.get(pos, [])
            result = train_position(career_rows, pos, feats, is_post_draft=True)
            if result:
                post_draft[pos] = result
                print(f'    {pos}: n={result["n"]}, R²={result["cvR2"]:.3f}, MAE={result["cvMAE"]:.1f}')

        with open(CACHE_PATHS['career_postdraft'], 'w') as f:
            json.dump({'rookieCareerModels': post_draft}, f)
        print(f'  Saved: {CACHE_PATHS["career_postdraft"]}')

    # ── Summary ─────────────────────────────────────────────────────
    elapsed = time.time() - total_start
    print(f'\nTotal training time: {elapsed:.1f}s')


if __name__ == '__main__':
    main()
