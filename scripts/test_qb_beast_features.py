#!/usr/bin/env python3
"""
Granular QB Beast-feature ablation across all four QB models.

The PDF-only career test (scripts/test_pdf_only_career.py) showed
pdf_only QB R²=0.191 vs shipped_full R²=-0.040 on the n=36 PDF-era
subset. That's a big enough gap to re-test adding Beast features to
the shipped QB models, which currently ship zero PDF features. But
the earlier group-level A/B (test_pdf_career_features.py PDF_FEATURE_SETS)
showed QB variants mostly hurt the full-history R². This runner:

  1. Loads career rows with PDF + disagreement features attached
     (same pipeline as train_career_models.load_career_rows).
  2. For each QB model (pre-draft regression, post-draft regression,
     boom gap, bust classifier), does a **single-feature-at-a-time**
     ablation over every Beast-derived candidate.
  3. Reports Δmetric in three regimes:
        - all yrs: score every LOSO fold (baseline-preserving test)
        - score≥22: train on all years, score only 2022-25 folds
        - train≥22: train AND score on 2022-25 rows only
     A feature only ships if it's non-negative on "all yrs" and
     positive on at least one of the recent regimes.
  4. Runs a greedy forward-selection pass on the survivors to find
     the best stable combination.

Outputs `public/data/qb-beast-ablation.json` with the full table.

Usage:
    python3 scripts/test_qb_beast_features.py
    python3 scripts/test_qb_beast_features.py --model pre    # just one
"""

import json
import math
import sys
import warnings
from pathlib import Path

import numpy as np
import lightgbm as lgb
from sklearn.linear_model import Ridge
from sklearn.metrics import r2_score, mean_absolute_error, roc_auc_score
from scipy.stats import spearmanr

warnings.filterwarnings('ignore')

sys.path.insert(0, str(Path(__file__).parent))
from train_career_models import (  # noqa: E402
    CACHE_PATH, load_career_rows, PRE_DRAFT_FEATURES, POST_DRAFT_FEATURES,
    POS_HYPERPARAMS, POS_RECENCY_SCHEMES, recency_weight,
    BOOM_GAP_FEATURES_BY_POS, BUST_FEATURES_BY_POS,
    _compute_gap_signals, _compute_bust_signals,
)

POS = 'QB'

# ── Candidate Beast-derived features ──────────────────────────────────
# PDF raw + derived, split into coherent groups for the forward-selection
# phase. The regression models take rows directly — keys are read from
# each row's features dict. Boom/bust use pre-computed signals.
REGRESSION_CANDIDATES = [
    'pdfHasData',
    'pdfRankOverallMean', 'pdfHasRank',
    'pdfRankOverallMin', 'pdfRankOverallMax', 'pdfRankSpread',
    'pdfProjectedRound', 'pdfHasRound',
    'pdfNStrengths', 'pdfNWeaknesses', 'pdfNRedFlags',
    'pdfSentimentNet',
    'pdfRankXPick', 'pdfRoundXActual',
    'recruit_production_gap', 'athletic_production_gap',
]

BOOM_CANDIDATES = REGRESSION_CANDIDATES
BUST_CANDIDATES = REGRESSION_CANDIDATES


# ── Shared helpers ────────────────────────────────────────────────────

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


# ── Regression evaluator (mirrors train_position regression blend) ────

def loso_regression(pos_rows: list, feature_keys: list[str],
                    regime: str = 'all') -> dict:
    """LOSO-by-season regression CV for QB.

    regime: 'all'      → score every fold, train on all years
            'score≥22' → same training, score only 2022-25 folds
            'train≥22' → train only on 2022-25 rows, score on 2022-25 folds
    """
    if regime == 'train≥22':
        pos_rows = [r for r in pos_rows if r['draft_season'] >= 2022]

    hyper = POS_HYPERPARAMS[POS]
    recency_scheme = POS_RECENCY_SCHEMES.get(POS)
    seasons = sorted(set(r['draft_season'] for r in pos_rows))
    if not seasons:
        return {'r2': None, 'mae': None, 'rho': None, 'n': 0}
    max_season = max(seasons)

    def expand(rows):
        if recency_scheme is None:
            return rows
        out = []
        for r in rows:
            out.extend([r] * recency_weight(r['draft_season'], max_season, recency_scheme))
        return out

    preds, actuals, held_arr = [], [], []
    for held in seasons:
        train_raw = [r for r in pos_rows if r['draft_season'] != held]
        test = [r for r in pos_rows if r['draft_season'] == held]
        if len(train_raw) < 10 or not test:
            continue
        train = expand(train_raw)
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
                dtr = lgb.Dataset(X_tr, y_tr, feature_name=feature_keys,
                                  free_raw_data=False)
                m = lgb.train(params, dtr, num_boost_round=hyper['n_estimators'])
                bag.append(m.predict(X_te))
            lgb_p = np.mean(bag, axis=0)
            final = np.clip((ridge_p + lgb_p) / 2, 0, None)
        else:
            final = np.clip(ridge_p, 0, None)
        for p, r in zip(final, test):
            preds.append(float(p))
            actuals.append(r['best2of3'])
            held_arr.append(held)

    preds, actuals, held_arr = np.array(preds), np.array(actuals), np.array(held_arr)
    if regime == 'score≥22':
        mask = held_arr >= 2022
        preds, actuals = preds[mask], actuals[mask]
    if len(preds) < 5:
        return {'r2': None, 'mae': None, 'rho': None, 'n': len(preds)}

    rho, _ = spearmanr(-preds, -actuals)
    return {
        'r2': round(float(r2_score(actuals, preds)), 4),
        'mae': round(float(mean_absolute_error(actuals, preds)), 3),
        'rho': round(float(rho), 4),
        'n': len(preds),
    }


# ── Boom / bust evaluators ────────────────────────────────────────────

def _qb_career_preds(pos_rows: list, feature_keys: list[str]) -> tuple[np.ndarray, np.ndarray, list]:
    """Base career-regression predictions used as the target-generator
    for boom/bust LOSO. Features/preds locked to `feature_keys` so
    we're measuring boom/bust marginal value, not regression value.
    """
    hyper = POS_HYPERPARAMS[POS]
    recency_scheme = POS_RECENCY_SCHEMES.get(POS)
    seasons = sorted(set(r['draft_season'] for r in pos_rows))
    max_season = max(seasons)

    def expand(rows):
        if recency_scheme is None:
            return rows
        out = []
        for r in rows:
            out.extend([r] * recency_weight(r['draft_season'], max_season, recency_scheme))
        return out

    preds, actuals, order = [], [], []
    for held in seasons:
        train_raw = [r for r in pos_rows if r['draft_season'] != held]
        test = [r for r in pos_rows if r['draft_season'] == held]
        if len(train_raw) < 10 or not test:
            continue
        train = expand(train_raw)
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
            order.append(r)
    return np.array(preds), np.array(actuals), order


def loso_boom_bust(pos_rows: list, base_feature_keys: list[str],
                    extra_gap_keys: list[str], extra_bust_keys: list[str],
                    recent_only: bool = False) -> dict:
    """LOSO boom/bust evaluation for QB with extras.

    Returns ρ_boom (Spearman of outperformance preds vs actual) and
    AUC_bust (LOSO-CV classifier AUC).
    """
    preds, actuals, order = _qb_career_preds(pos_rows, base_feature_keys)
    n = len(preds)
    if n < 20:
        return {'rho_boom': None, 'auc_bust': None, 'n': n}

    pred_ranks = np.argsort(np.argsort(preds)) / n
    actual_ranks = np.argsort(np.argsort(actuals)) / n
    outperf = actual_ranks - pred_ranks

    mae = float(np.mean(np.abs(actuals - preds)))
    boom_thresh = mae * 0.75
    y_bust = np.array([1 if (a - p) < -boom_thresh else 0 for a, p in zip(actuals, preds)])

    gap_base_keys = list(BOOM_GAP_FEATURES_BY_POS[POS])
    bust_base_keys = list(BUST_FEATURES_BY_POS[POS])
    # Dedupe: if the candidate is already in the shipped per-position
    # list (future-proofing when we ship some of these), skip it.
    gap_keys = gap_base_keys + [k for k in extra_gap_keys if k not in gap_base_keys]
    bust_keys = bust_base_keys + [k for k in extra_bust_keys if k not in bust_base_keys]

    # Mean per-fold speed/dom hits (same formula as train_career_models)
    def build_gap(r):
        sig = _compute_gap_signals(r['features'])
        # Add disagreement + PDF signals by reading the row's features dict
        for k in extra_gap_keys:
            if k not in sig:
                sig[k] = _cell(r['features'].get(k, 0))
        return [sig.get(k, 0.0) for k in gap_keys]

    def build_bust(r, pred):
        sig = _compute_bust_signals(r['features'], pred, 100.0, 30.0)
        for k in extra_bust_keys:
            if k not in sig:
                sig[k] = _cell(r['features'].get(k, 0))
        return [sig.get(k, 0.0) for k in bust_keys]

    X_gap = np.nan_to_num(np.array([build_gap(r) for r in order], dtype=np.float64))
    X_bust = np.nan_to_num(np.array([build_bust(r, preds[i]) for i, r in enumerate(order)],
                                    dtype=np.float64))

    outperf_pred = np.zeros(n)
    bust_pred = np.full(n, float(y_bust.mean()))

    seasons = sorted({r['draft_season'] for r in order})
    for s in seasons:
        tr_idx = [i for i, r in enumerate(order) if r['draft_season'] != s]
        te_idx = [i for i, r in enumerate(order) if r['draft_season'] == s]
        if len(tr_idx) < 20 or not te_idx:
            continue
        gp = {
            'objective': 'regression', 'metric': 'mae', 'learning_rate': 0.03,
            'max_depth': 2, 'min_child_samples': max(5, len(tr_idx) // 8),
            'subsample': 0.7, 'colsample_bytree': 0.6, 'verbose': -1, 'seed': 42,
            'n_jobs': 1, 'extra_trees': True,
        }
        dt = lgb.Dataset(X_gap[tr_idx], outperf[tr_idx], feature_name=gap_keys,
                         free_raw_data=False)
        gm = lgb.train(gp, dt, num_boost_round=60)
        outperf_pred[te_idx] = gm.predict(X_gap[te_idx])

        if sum(y_bust[tr_idx]) >= 3:
            bp = {
                'objective': 'binary', 'metric': 'auc', 'learning_rate': 0.03,
                'max_depth': 2, 'min_child_samples': max(3, len(tr_idx) // 10),
                'subsample': 0.7, 'colsample_bytree': 0.6, 'verbose': -1,
                'seed': 42, 'n_jobs': 1, 'is_unbalance': True, 'extra_trees': True,
            }
            dtb = lgb.Dataset(X_bust[tr_idx], y_bust[tr_idx], feature_name=bust_keys,
                              free_raw_data=False)
            bm = lgb.train(bp, dtb, num_boost_round=60)
            bust_pred[te_idx] = bm.predict(X_bust[te_idx])

    held = np.array([r['draft_season'] for r in order])
    mask = held >= 2022 if recent_only else np.ones(n, dtype=bool)
    if mask.sum() < 5:
        return {'rho_boom': None, 'auc_bust': None, 'n': int(mask.sum())}

    rho, _ = spearmanr(outperf_pred[mask], outperf[mask])
    yb, bp_ = y_bust[mask], bust_pred[mask]
    if yb.sum() == 0 or yb.sum() == len(yb):
        auc = None
    else:
        auc = float(roc_auc_score(yb, bp_))
    return {
        'rho_boom': round(float(rho), 4),
        'auc_bust': round(auc, 4) if auc is not None else None,
        'n': int(mask.sum()),
    }


# ── Main ablation loops ───────────────────────────────────────────────

def ablate_regression(qb_rows: list, base_keys: list[str], label: str):
    print(f"\n=== {label} regression ablation ===")
    print(f"Baseline ({len(base_keys)} features): {base_keys}")
    base = {
        'all': loso_regression(qb_rows, base_keys, 'all'),
        'score≥22': loso_regression(qb_rows, base_keys, 'score≥22'),
        'train≥22': loso_regression(qb_rows, base_keys, 'train≥22'),
    }
    for k, v in base.items():
        print(f"  baseline {k:10s}: R²={v['r2']}, MAE={v['mae']}, ρ={v['rho']}, n={v['n']}")

    results = {'baseline': base, 'single_adds': {}}
    ships = []
    for cand in REGRESSION_CANDIDATES:
        if cand in base_keys:
            continue
        keys = base_keys + [cand]
        m_all = loso_regression(qb_rows, keys, 'all')
        m_score = loso_regression(qb_rows, keys, 'score≥22')
        m_train = loso_regression(qb_rows, keys, 'train≥22')
        d_all = round(m_all['r2'] - base['all']['r2'], 4)
        d_score = round(m_score['r2'] - base['score≥22']['r2'], 4)
        d_train = round(m_train['r2'] - base['train≥22']['r2'], 4) if m_train['r2'] is not None and base['train≥22']['r2'] is not None else None
        mark = ''
        if d_all >= -0.002 and (d_score > 0 or (d_train is not None and d_train > 0)):
            mark = ' ← candidate'
            ships.append(cand)
        print(f"  +{cand:30s}: Δall={d_all:+.4f}, Δscore≥22={d_score:+.4f}, Δtrain≥22={d_train}{mark}")
        results['single_adds'][cand] = {
            'all': m_all, 'score≥22': m_score, 'train≥22': m_train,
            'delta_all_r2': d_all, 'delta_score_r2': d_score, 'delta_train_r2': d_train,
        }

    # Forward selection on shippable candidates
    if ships:
        print(f"\n  Forward selection from {len(ships)} candidates: {ships}")
        selected = list(base_keys)
        best_all = base['all']['r2']
        for cand in ships:
            trial = selected + [cand]
            m = loso_regression(qb_rows, trial, 'all')
            m_score = loso_regression(qb_rows, trial, 'score≥22')
            m_train = loso_regression(qb_rows, trial, 'train≥22')
            d_all = m['r2'] - best_all
            if m['r2'] >= best_all - 0.002 and (
                m_score['r2'] >= base['score≥22']['r2']
                or (m_train['r2'] is not None and m_train['r2'] >= base['train≥22']['r2'])
            ):
                selected.append(cand)
                best_all = m['r2']
                print(f"    + {cand}: all R²={m['r2']}, score R²={m_score['r2']}, train R²={m_train['r2']} (keeps)")
            else:
                print(f"    − {cand}: all R²={m['r2']}, score R²={m_score['r2']}, train R²={m_train['r2']} (drops)")
        results['forward_selected'] = [k for k in selected if k not in base_keys]
        results['forward_selected_all_r2'] = best_all
        print(f"  → Final add: {results['forward_selected']}, all yrs R²={best_all:.4f}")
    else:
        results['forward_selected'] = []
        print("\n  No shippable candidates.")

    return results


def ablate_boom_bust(qb_rows: list, base_keys: list[str], label: str):
    print(f"\n=== {label} boom/bust ablation ===")
    base_all = loso_boom_bust(qb_rows, base_keys, [], [])
    base_recent = loso_boom_bust(qb_rows, base_keys, [], [], recent_only=True)
    print(f"  baseline (all yrs)  : ρ_boom={base_all['rho_boom']}, AUC_bust={base_all['auc_bust']}")
    print(f"  baseline (score≥22) : ρ_boom={base_recent['rho_boom']}, AUC_bust={base_recent['auc_bust']}")

    out = {'baseline_all': base_all, 'baseline_recent': base_recent, 'boom_adds': {}, 'bust_adds': {}}

    boom_ships = []
    print("\n  -- boom (gap regression) single-adds --")
    for cand in BOOM_CANDIDATES:
        m_all = loso_boom_bust(qb_rows, base_keys, [cand], [])
        m_recent = loso_boom_bust(qb_rows, base_keys, [cand], [], recent_only=True)
        d_all = round((m_all['rho_boom'] or 0) - (base_all['rho_boom'] or 0), 4) if m_all['rho_boom'] is not None else None
        d_recent = round((m_recent['rho_boom'] or 0) - (base_recent['rho_boom'] or 0), 4) if m_recent['rho_boom'] is not None else None
        mark = ''
        if d_all is not None and d_all >= -0.005 and ((d_recent or 0) > 0 or (d_all > 0)):
            mark = ' ← candidate'
            boom_ships.append(cand)
        print(f"  +{cand:30s}: Δρ_all={d_all}, Δρ_recent={d_recent}{mark}")
        out['boom_adds'][cand] = {'all': m_all, 'recent': m_recent, 'delta_all': d_all, 'delta_recent': d_recent}

    bust_ships = []
    print("\n  -- bust (binary) single-adds --")
    for cand in BUST_CANDIDATES:
        m_all = loso_boom_bust(qb_rows, base_keys, [], [cand])
        m_recent = loso_boom_bust(qb_rows, base_keys, [], [cand], recent_only=True)
        d_all = round((m_all['auc_bust'] or 0) - (base_all['auc_bust'] or 0), 4) if m_all['auc_bust'] is not None else None
        d_recent = round((m_recent['auc_bust'] or 0) - (base_recent['auc_bust'] or 0), 4) if m_recent['auc_bust'] is not None else None
        mark = ''
        if d_all is not None and d_all >= -0.005 and ((d_recent or 0) > 0 or (d_all > 0)):
            mark = ' ← candidate'
            bust_ships.append(cand)
        print(f"  +{cand:30s}: ΔAUC_all={d_all}, ΔAUC_recent={d_recent}{mark}")
        out['bust_adds'][cand] = {'all': m_all, 'recent': m_recent, 'delta_all': d_all, 'delta_recent': d_recent}

    # Forward selection on shippable candidates (boom + bust)
    if boom_ships:
        print(f"\n  Forward selection boom from {boom_ships}")
        sel_boom = []
        best = base_all['rho_boom']
        for cand in boom_ships:
            trial = sel_boom + [cand]
            m = loso_boom_bust(qb_rows, base_keys, trial, [])
            if m['rho_boom'] is not None and m['rho_boom'] >= best - 0.005:
                sel_boom.append(cand)
                best = m['rho_boom']
                print(f"    + {cand}: ρ_all={m['rho_boom']} (keeps)")
            else:
                print(f"    − {cand}: ρ_all={m['rho_boom']} (drops)")
        out['forward_selected_boom'] = sel_boom
        out['forward_selected_boom_rho'] = best
    else:
        out['forward_selected_boom'] = []
    if bust_ships:
        print(f"\n  Forward selection bust from {bust_ships}")
        sel_bust = []
        best = base_all['auc_bust']
        for cand in bust_ships:
            trial = sel_bust + [cand]
            m = loso_boom_bust(qb_rows, base_keys, [], trial)
            if m['auc_bust'] is not None and m['auc_bust'] >= best - 0.005:
                sel_bust.append(cand)
                best = m['auc_bust']
                print(f"    + {cand}: AUC_all={m['auc_bust']} (keeps)")
            else:
                print(f"    − {cand}: AUC_all={m['auc_bust']} (drops)")
        out['forward_selected_bust'] = sel_bust
        out['forward_selected_bust_auc'] = best
    else:
        out['forward_selected_bust'] = []

    return out


def main():
    args = sys.argv[1:]
    run_models = {'pre', 'post', 'boom_bust'}
    for a in args:
        if a == '--model=pre' or a == '--pre':
            run_models = {'pre'}
        elif a == '--model=post' or a == '--post':
            run_models = {'post'}
        elif a == '--model=boom_bust' or a == '--boom-bust':
            run_models = {'boom_bust'}

    print(f"Loading career rows from {CACHE_PATH}...")
    rows = load_career_rows(CACHE_PATH)
    qb_rows = [r for r in rows if r['position'] == POS]
    print(f"  {len(qb_rows)} QB rows (of {len(rows)} total)")

    results = {}
    if 'pre' in run_models:
        results['pre_draft'] = ablate_regression(qb_rows, PRE_DRAFT_FEATURES[POS], 'PRE-DRAFT')
    if 'post' in run_models:
        results['post_draft'] = ablate_regression(qb_rows, POST_DRAFT_FEATURES[POS], 'POST-DRAFT')
    if 'boom_bust' in run_models:
        results['boom_bust'] = ablate_boom_bust(qb_rows, PRE_DRAFT_FEATURES[POS], 'QB (pre-draft base)')

    out = Path('public/data/qb-beast-ablation.json')
    with open(out, 'w') as f:
        json.dump(results, f, indent=2)
    print(f"\nSaved summary to {out}")


if __name__ == '__main__':
    main()
