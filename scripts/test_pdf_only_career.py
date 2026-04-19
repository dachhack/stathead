#!/usr/bin/env python3
"""
Rookie career model trained on PDF-only (The Beast) features.

Tests whether scouting features from The Beast alone carry enough signal
to rank rookies by best-2-of-3-PPG without any NFL draft capital, combine,
college production, or CFBD inputs. Restricted to the PDF era (2022-2025
draft classes) — ~120 WRs, ~80 RBs, ~60 TEs, ~40 QBs.

Three comparisons per position, same LOSO-by-season protocol:

  1. `draft_pick`   : logDraftPick + nflDraftPick only. Lower-bound
                      baseline — the model knows only where the NFL drafted
                      the player.
  2. `pdf_only`     : PDF-derived features only (rank, round, sentiment,
                      red flags, consensus, tier). No draft capital, no
                      combine, no college stats.
  3. `pdf_plus_pick`: PDF features + logDraftPick. Measures whether
                      scouting adds marginal signal on top of pure draft
                      capital.
  4. `shipped_full` : PRE_DRAFT_FEATURES[pos] from train_career_models.
                      Upper bound — everything we have.

Usage:
    python3 scripts/test_pdf_only_career.py                # all positions
    python3 scripts/test_pdf_only_career.py --pos WR       # single position
"""

import json
import math
import sys
import warnings
from pathlib import Path

import numpy as np
import lightgbm as lgb
from sklearn.linear_model import Ridge
from sklearn.metrics import r2_score, mean_absolute_error
from scipy.stats import spearmanr

warnings.filterwarnings('ignore')

sys.path.insert(0, str(Path(__file__).parent))
from train_career_models import (  # noqa: E402
    CACHE_PATH, load_career_rows, PRE_DRAFT_FEATURES,
    POS_HYPERPARAMS,
)


PDF_FEATURES_ALL = [
    'pdfHasData',
    'pdfRankOverallMean', 'pdfRankOverallMin', 'pdfRankOverallMax',
    'pdfRankSpread', 'pdfProjectedRound',
    'pdfHasRank', 'pdfHasRound',
    'pdfNStrengths', 'pdfNWeaknesses', 'pdfNRedFlags',
    'pdfSentimentNet',
]

# Per-position feature sets. RB/TE have so few PDF scouts per class that
# rank_max and rank_min add little over rank_mean; trimmed to reduce
# overfitting risk at small n.
PDF_ONLY_FEATURES = {
    'QB': PDF_FEATURES_ALL,
    'RB': [f for f in PDF_FEATURES_ALL if f not in ('pdfRankOverallMax', 'pdfRankOverallMin')],
    'WR': PDF_FEATURES_ALL,
    'TE': [f for f in PDF_FEATURES_ALL if f not in ('pdfRankOverallMax', 'pdfRankOverallMin')],
}

PICK_ONLY_FEATURES = ['logDraftPick', 'nflDraftPick']


def _cell(v) -> float:
    if v is None or v == '' or v == 'NA' or v == 'NaN':
        return 0.0
    try:
        f = float(v)
        return f if math.isfinite(f) else 0.0
    except (TypeError, ValueError):
        return 0.0


def make_X(rows: list, keys: list[str]) -> np.ndarray:
    return np.array([[_cell(r['features'].get(k, 0)) for k in keys] for r in rows])


def make_y(rows: list) -> np.ndarray:
    return np.array([r['best2of3'] for r in rows])


def loso_eval(pos_rows: list, feature_keys: list[str], pos: str) -> dict:
    """LOSO-by-draft-season for a given feature set.

    Mirrors train_career_models.train_position's regression blend (Ridge +
    bagged LightGBM when n >= 40), but skipped companion model and
    threshold classifiers — we only need regression R²/MAE/ρ here.
    """
    hyper = POS_HYPERPARAMS.get(pos, POS_HYPERPARAMS['WR'])
    seasons = sorted(set(r['draft_season'] for r in pos_rows))

    preds, actuals = [], []
    for held in seasons:
        train = [r for r in pos_rows if r['draft_season'] != held]
        test = [r for r in pos_rows if r['draft_season'] == held]
        if len(train) < 10 or not test:
            continue
        X_tr, y_tr = make_X(train, feature_keys), make_y(train)
        X_te = make_X(test, feature_keys)

        ridge = Ridge(alpha=hyper['ridge_alpha'])
        ridge.fit(X_tr, y_tr)
        ridge_p = ridge.predict(X_te)

        if len(train) >= 40:
            bag = []
            for bi in range(5):
                params = {
                    'objective': 'regression', 'metric': 'mae',
                    'learning_rate': hyper['lr'], 'max_depth': hyper['max_depth'],
                    'min_child_samples': hyper['min_child'],
                    'subsample': 0.8, 'colsample_bytree': 0.8,
                    'bagging_fraction': 0.8, 'bagging_freq': 1,
                    'extra_trees': True,
                    'verbose': -1, 'seed': 42 + bi, 'n_jobs': 1,
                }
                dtr = lgb.Dataset(X_tr, y_tr, feature_name=feature_keys, free_raw_data=False)
                m = lgb.train(params, dtr, num_boost_round=hyper['n_estimators'])
                bag.append(m.predict(X_te))
            lgb_p = np.mean(bag, axis=0)
            final = np.clip((ridge_p + lgb_p) / 2, 0, None)
        else:
            final = np.clip(ridge_p, 0, None)
        for p, r in zip(final, test):
            preds.append(float(p))
            actuals.append(r['best2of3'])

    preds, actuals = np.array(preds), np.array(actuals)
    if len(preds) < 5:
        return {'r2': None, 'mae': None, 'rho': None, 'n': len(preds)}
    rho, _ = spearmanr(-preds, -actuals)
    return {
        'r2': round(float(r2_score(actuals, preds)), 4),
        'mae': round(float(mean_absolute_error(actuals, preds)), 3),
        'rho': round(float(rho), 4),
        'n': len(preds),
    }


def final_feature_importance(pos_rows: list, feature_keys: list[str],
                              pos: str) -> list[dict]:
    """Train one LightGBM on all data, return normalized gain importance.

    Direction is inferred from Spearman(feature, target); gain importance
    has no natural sign.
    """
    hyper = POS_HYPERPARAMS.get(pos, POS_HYPERPARAMS['WR'])
    X = make_X(pos_rows, feature_keys)
    y = make_y(pos_rows)
    if len(pos_rows) < 20:
        return []
    dt = lgb.Dataset(X, y, feature_name=feature_keys, free_raw_data=False)
    model = lgb.train({
        'objective': 'regression', 'metric': 'mae',
        'learning_rate': hyper['lr'], 'max_depth': hyper['max_depth'],
        'min_child_samples': hyper['min_child'],
        'subsample': 0.8, 'colsample_bytree': 0.8,
        'extra_trees': True,
        'verbose': -1, 'seed': 42, 'n_jobs': 1,
    }, dt, num_boost_round=hyper['n_estimators'])
    gains = model.feature_importance(importance_type='gain')
    total = float(gains.sum())
    if total <= 0:
        return []
    out = []
    for i, name in enumerate(feature_keys):
        if gains[i] <= 0:
            continue
        try:
            rho, _ = spearmanr(X[:, i], y)
            if math.isnan(rho):
                rho = 0.0
        except Exception:
            rho = 0.0
        out.append({
            'key': name,
            'importance': round(float(gains[i]) / total, 4),
            'direction': 'positive' if rho >= 0 else 'negative',
        })
    return sorted(out, key=lambda e: -e['importance'])


def run(positions: list[str], restrict_pos: str | None = None) -> dict:
    print(f"Loading career rows from {CACHE_PATH}...")
    all_rows = load_career_rows(CACHE_PATH)
    print(f"  {len(all_rows)} total career rows")

    # PDF era restriction. Pre-2022 rookies get zero-filled PDF features
    # (no coverage), so training on them would poison the PDF-only signal.
    pdf_rows = [r for r in all_rows if 2022 <= r['draft_season'] <= 2025]
    print(f"  {len(pdf_rows)} rows in PDF era (2022-2025)")

    results = {}
    for pos in positions:
        if restrict_pos and pos != restrict_pos:
            continue
        pos_rows = [r for r in pdf_rows if r['position'] == pos]
        if len(pos_rows) < 15:
            print(f"  {pos}: only {len(pos_rows)} rows in PDF era — skipping")
            continue

        seasons = sorted(set(r['draft_season'] for r in pos_rows))
        print(f"\n── {pos} (n={len(pos_rows)}, seasons={seasons}) ──")

        # Variants
        variants = {
            'draft_pick': PICK_ONLY_FEATURES,
            'pdf_only': PDF_ONLY_FEATURES[pos],
            'pdf_plus_pick': PDF_ONLY_FEATURES[pos] + ['logDraftPick'],
            'shipped_full': PRE_DRAFT_FEATURES[pos],
        }
        pos_results = {}
        for name, keys in variants.items():
            r = loso_eval(pos_rows, keys, pos)
            r['feature_count'] = len(keys)
            pos_results[name] = r
            print(f"  {name:15s} (n_features={len(keys):2d}): "
                  f"R²={r['r2']}, MAE={r['mae']}, ρ={r['rho']}, n_scored={r['n']}")

        # Feature importance for pdf_only
        imp = final_feature_importance(pos_rows, PDF_ONLY_FEATURES[pos], pos)
        if imp:
            print(f"  pdf_only importance (top 8):")
            for f in imp[:8]:
                arrow = '↑' if f['direction'] == 'positive' else '↓'
                print(f"    {f['key']:28s} {f['importance']:.3f} {arrow}")
        pos_results['pdf_only_importance'] = imp

        results[pos] = pos_results

    return results


def main():
    pos = None
    args = sys.argv[1:]
    for i, a in enumerate(args):
        if a.startswith('--pos='):
            pos = a.split('=', 1)[1]
        elif a == '--pos' and i + 1 < len(args):
            pos = args[i + 1]

    results = run(['QB', 'RB', 'WR', 'TE'], restrict_pos=pos)
    out = Path('public/data/pdf-only-career-test.json')
    with open(out, 'w') as f:
        json.dump({'results': results}, f, indent=2)
    print(f"\nSaved summary to {out}")


if __name__ == '__main__':
    main()
