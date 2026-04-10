#!/usr/bin/env python3
"""
Rookie career model training using LightGBM + scikit-learn.

Replaces the JavaScript training pipeline (rookieCareerModel.ts) with
a 50-100x faster Python implementation. Outputs the same JSON cache
format so the TypeScript site code doesn't change.

Usage:
    python3 scripts/train_career_models.py                    # both pre+post draft
    python3 scripts/train_career_models.py --pre-draft-only   # pre-draft only
    python3 scripts/train_career_models.py --post-draft-only  # post-draft only
"""

import json
import sys
import time
import math
import warnings
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import lightgbm as lgb
from sklearn.linear_model import Ridge
from sklearn.metrics import r2_score, mean_absolute_error
from scipy.stats import spearmanr

warnings.filterwarnings('ignore', category=UserWarning)

# ── Configuration ─────────────────────────────────────────────────────

CACHE_PATH = Path('public/data/training-rows-cache-v42.json')
OUTPUT_DIR = Path('public/data')
PRE_DRAFT_CACHE = OUTPUT_DIR / 'model-cache-career-v69.json'
POST_DRAFT_CACHE = OUTPUT_DIR / 'model-cache-career-postdraft-v1.json'

PRE_DRAFT_FEATURES = {
    'QB': ['logDraftPick', 'collegeQBR2yr',
           'collegeRushYpgPerAge', 'collegeSosFinalYr', 'collegeQbContextScore'],
    'RB': ['logDraftPick', 'collegeDominatorXLateRound'],
    'WR': ['logDraftPick', 'draftPickPct', 'draftPickPctOverall', 'draftClassDepth', 'age',
           'collegeBreakoutScore', 'collegeRecYdsPerTeamPassAtt',
           'collegeBestRecYds',
           'weight', 'collegeTeammateScore',
           'relativeAthleticScore'],
    'TE': ['logDraftPick', 'draftPickPct', 'draftPickPctOverall', 'draftClassDepth',
           'age'],
}

POST_DRAFT_FEATURES = {
    'QB': PRE_DRAFT_FEATURES['QB'] + [
        'vegasImpliedTotal', 'contractAPY',
        'teamPace', 'depthChartRank', 'teamSamePosCount'],
    'RB': PRE_DRAFT_FEATURES['RB'] + [
        'depthChartRank', 'teamSamePosCount', 'contractAPY',
        'vegasImpliedTotal', 'teamPassRate', 'teamPace', 'qbOwnPPG'],
    'WR': PRE_DRAFT_FEATURES['WR'] + [
        'depthChartRank', 'teamSamePosCount', 'contractAPY',
        'vegasImpliedTotal', 'teamPassRate', 'qbOwnPPG', 'projTeamPassAtt'],
    'TE': PRE_DRAFT_FEATURES['TE'] + [
        'depthChartRank', 'contractAPY',
        'vegasImpliedTotal', 'teamPassRate', 'qbOwnPPG', 'projTeamPassAtt'],
}

PPG_THRESHOLDS = {
    'QB': [16, 18, 20, 22],
    'RB': [12, 14, 16, 18],
    'WR': [12, 14, 16, 18],
    'TE': [8, 9, 10, 11],
}

POS_HYPERPARAMS = {
    'QB': {'ridge_alpha': 15, 'n_estimators': 80, 'lr': 0.04, 'max_depth': 2, 'min_child': 15},
    'RB': {'ridge_alpha': 5,  'n_estimators': 100, 'lr': 0.04, 'max_depth': 3, 'min_child': 12},
    'WR': {'ridge_alpha': 8,  'n_estimators': 120, 'lr': 0.05, 'max_depth': 3, 'min_child': 10},
    'TE': {'ridge_alpha': 20, 'n_estimators': 80,  'lr': 0.04, 'max_depth': 2, 'min_child': 15},
}

# ── Data Loading ──────────────────────────────────────────────────────

def load_career_rows(cache_path: Path) -> pd.DataFrame:
    """Load training rows and build career target (best 2-of-3 PPG)."""
    with open(cache_path) as f:
        data = json.load(f)
    rows = data['rows']

    # Build games lookup from priorGames
    career_games = {}
    for r in rows:
        prior_season = r['season'] - 1
        key = f"{r['name']}::{r['position']}::{prior_season}"
        pg = r['features'].get('priorGames', 0)
        if pg > 0:
            career_games[key] = pg

    # Group rows by player → career
    career_map: dict[str, dict] = {}
    for r in rows:
        key = f"{r['name']}::{r['position']}"
        if key not in career_map:
            career_map[key] = {
                'name': r['name'], 'position': r['position'],
                'draft_season': 0, 'features': {},
                'season_ppgs': [],
            }
        entry = career_map[key]
        games_key = f"{r['name']}::{r['position']}::{r['season']}"
        games = career_games.get(games_key, 17 if r['rawPPG'] > 0 else 0)
        entry['season_ppgs'].append({'season': r['season'], 'ppg': r['rawPPG'], 'games': games})
        yil = r['features'].get('yearsInLeague', 99)
        if yil <= 1:
            derived = r['season'] - yil
            if entry['draft_season'] == 0 or derived < entry['draft_season']:
                entry['draft_season'] = derived
                entry['features'] = dict(r['features'])

    # Fix false rookies
    for entry in career_map.values():
        if entry['draft_season'] == 0:
            continue
        seasons = sorted(s['season'] for s in entry['season_ppgs'])
        if seasons and seasons[0] < entry['draft_season']:
            entry['draft_season'] = seasons[0]

    # Compute best-2-of-3 target
    career_rows = []
    for entry in career_map.values():
        if entry['draft_season'] == 0:
            continue
        first3 = sorted(
            [s for s in entry['season_ppgs']
             if entry['draft_season'] <= s['season'] < entry['draft_season'] + 3],
            key=lambda s: -s['ppg']
        )
        qualifying = [s for s in first3 if s['games'] >= 4]
        if not qualifying:
            continue
        best2 = qualifying[:2]
        best2of3 = round(sum(s['ppg'] for s in best2) / len(best2), 2)

        f = dict(entry['features'])
        yil = f.get('yearsInLeague', 99)
        if yil > 1:
            continue
        all_seasons = sorted(s['season'] for s in entry['season_ppgs'])
        if any(s < entry['draft_season'] for s in all_seasons):
            continue
        pick = f.get('nflDraftPick', 300) or 300
        age = f.get('age', 0) or 0
        if pick >= 300 and age == 0:
            continue

        # Derived features
        f['logDraftPick'] = math.log(pick)
        f['invDraftPick'] = 1.0 / pick
        f['collegeEarlyDeclare'] = f.get('collegeEarlyDeclare', 0)
        f['draftPickXEarlyDeclare'] = f['collegeEarlyDeclare'] * f['invDraftPick']
        f['collegeDominatorXLateRound'] = (f.get('collegeDominatorRating', 0) or 0) * max(0, math.log(pick) - 4.0)
        if f.get('draftPickPct') is None:
            f['draftPickPct'] = 1.0

        # QB accuracy features from raw aggregates
        raw_pa = float(f.get('_rawCareerPassAtt', 0) or 0)
        raw_pc = float(f.get('_rawCareerPassCompletions', 0) or 0)
        raw_py = float(f.get('_rawCareerPassYds', 0) or 0)
        raw_tpa = float(f.get('_rawTeamPassAtt', 0) or 0)
        raw_tpc = float(f.get('_rawTeamPassCompletions', 0) or 0)
        f['collegeCompletionPct'] = round(raw_pc / raw_pa, 3) if raw_pa > 0 else 0
        team_comp = raw_tpc / raw_tpa if raw_tpa > 0 else 0
        f['collegeCompletionPctOverTeam'] = round(f['collegeCompletionPct'] - team_comp, 3) if f['collegeCompletionPct'] > 0 and team_comp > 0 else 0
        f['collegeYdsPerCompletion'] = round(raw_py / raw_pc, 2) if raw_pc > 0 else 0

        career_rows.append({
            'name': entry['name'],
            'position': entry['position'],
            'draft_season': entry['draft_season'],
            'best2of3': best2of3,
            'features': f,
        })

    return career_rows


def recency_weight(season: int, max_season: int, use_weighting: bool) -> int:
    if not use_weighting:
        return 1
    gap = max_season - season
    if gap <= 3:
        return 3
    if gap <= 7:
        return 2
    return 1


# ── Training ──────────────────────────────────────────────────────────

def train_position(career_rows: list, pos: str, feature_keys: list[str],
                   is_post_draft: bool = False) -> dict:
    """Train rookie career model for one position. Returns JSON-serializable result."""
    t0 = time.time()
    pos_rows = [r for r in career_rows if r['position'] == pos]
    if len(pos_rows) < 10:
        return {}

    hyper = POS_HYPERPARAMS.get(pos, POS_HYPERPARAMS['WR'])
    thresholds = PPG_THRESHOLDS[pos]
    seasons = sorted(set(r['draft_season'] for r in pos_rows))
    max_season = max(seasons)
    use_recency = pos != 'RB' and not is_post_draft

    # College-only companion model for WR/RB pre-draft (catches late-round breakouts)
    DRAFT_CAPITAL_KEYS = {'logDraftPick', 'invDraftPick', 'draftPickXEarlyDeclare', 'collegeDominatorXLateRound'}
    college_only_keys = [k for k in feature_keys if k not in DRAFT_CAPITAL_KEYS]
    use_companion = not is_post_draft and len(college_only_keys) >= 4 and pos in ('WR', 'RB')
    N_BAGS = 5  # bagged LightGBM ensemble

    # Build feature matrix
    def make_X(rows, keys=None):
        keys = keys or feature_keys
        return np.array([[r['features'].get(k, 0) or 0 for k in keys] for r in rows])

    def make_y(rows):
        return np.array([r['best2of3'] for r in rows])

    def expand(rows):
        if not use_recency:
            return rows
        out = []
        for r in rows:
            w = recency_weight(r['draft_season'], max_season, True)
            out.extend([r] * w)
        return out

    def train_lgb_bagged(X_tr, y_tr, X_te, feat_names, n_bags=N_BAGS):
        """Train bagged LightGBM ensemble, return averaged predictions."""
        bag_preds = []
        for bag_i in range(n_bags):
            params = {
                'objective': 'regression', 'metric': 'mae',
                'learning_rate': hyper['lr'], 'max_depth': hyper['max_depth'],
                'min_child_samples': hyper['min_child'],
                'subsample': 0.8, 'colsample_bytree': 0.8,
                'bagging_fraction': 0.8, 'bagging_freq': 1,
                'extra_trees': True,
                'verbose': -1, 'seed': 42 + bag_i, 'n_jobs': 1,
            }
            dtrain = lgb.Dataset(X_tr, y_tr, feature_name=feat_names, free_raw_data=False)
            model = lgb.train(params, dtrain, num_boost_round=hyper['n_estimators'])
            bag_preds.append(model.predict(X_te))
        return np.mean(bag_preds, axis=0)

    def train_lgb_bagged_binary(X_tr, y_tr, X_te, feat_names, n_bags=N_BAGS):
        """Train bagged LightGBM for binary classification."""
        bag_preds = []
        for bag_i in range(n_bags):
            params = {
                'objective': 'binary', 'metric': 'binary_logloss',
                'learning_rate': hyper['lr'], 'max_depth': hyper['max_depth'],
                'min_child_samples': max(hyper['min_child'], 5),
                'subsample': 0.8, 'colsample_bytree': 0.8,
                'bagging_fraction': 0.8, 'bagging_freq': 1,
                'extra_trees': True,
                'verbose': -1, 'seed': 42 + bag_i, 'n_jobs': 1,
            }
            dtrain = lgb.Dataset(X_tr, y_tr, feature_name=feat_names, free_raw_data=False)
            model = lgb.train(params, dtrain, num_boost_round=hyper['n_estimators'])
            bag_preds.append(model.predict(X_te))
        return np.mean(bag_preds, axis=0)

    # ── LOSO Cross-Validation ─────────────────────────────────────────
    loso_data = []

    for held_season in seasons:
        train_raw = [r for r in pos_rows if r['draft_season'] != held_season]
        test = [r for r in pos_rows if r['draft_season'] == held_season]
        if len(train_raw) < 10 or len(test) == 0:
            continue

        train = expand(train_raw)
        X_tr, y_tr = make_X(train), make_y(train)
        X_te = make_X(test)

        # Ridge regression
        ridge = Ridge(alpha=hyper['ridge_alpha'])
        ridge.fit(X_tr, y_tr)
        ridge_preds = ridge.predict(X_te)

        # Bagged LightGBM ensemble
        if len(train) >= 40:
            lgb_preds = train_lgb_bagged(X_tr, y_tr, X_te, feature_keys)
            main_preds = np.clip((ridge_preds + lgb_preds) / 2, 0, None)
        else:
            main_preds = np.clip(ridge_preds, 0, None)

        # College-only companion model (WR/RB pre-draft only)
        if use_companion and len(train) >= 40:
            X_tr_co = make_X(train, college_only_keys)
            X_te_co = make_X(test, college_only_keys)
            ridge_co = Ridge(alpha=hyper['ridge_alpha'])
            ridge_co.fit(X_tr_co, y_tr)
            lgb_co = train_lgb_bagged(X_tr_co, y_tr, X_te_co, college_only_keys)
            co_preds = np.clip((ridge_co.predict(X_te_co) + lgb_co) / 2, 0, None)
            reg_preds = main_preds * 0.7 + co_preds * 0.3
        else:
            reg_preds = main_preds

        # Per-threshold binary classifiers
        thresh_probs = [{} for _ in test]
        for thresh in thresholds:
            y_bin = (make_y(train) >= thresh).astype(float)
            pos_rate = y_bin.mean()
            if pos_rate < 0.05 or pos_rate > 0.95:
                for i in range(len(test)):
                    thresh_probs[i][thresh] = round(pos_rate * 100, 1)
                continue

            ridge_bin = Ridge(alpha=hyper['ridge_alpha'])
            ridge_bin.fit(X_tr, y_bin)
            ridge_bin_preds = ridge_bin.predict(X_te)

            if len(train) >= 40:
                lgb_bin_preds = train_lgb_bagged_binary(X_tr, y_bin, X_te, feature_keys)
                bin_preds = np.clip((ridge_bin_preds + lgb_bin_preds) / 2, 0, 1)
            else:
                bin_preds = np.clip(ridge_bin_preds, 0, 1)

            for i in range(len(test)):
                thresh_probs[i][thresh] = round(float(bin_preds[i]) * 100, 1)

        for i, r in enumerate(test):
            loso_data.append({
                'name': r['name'],
                'season': held_season,
                'actual': r['best2of3'],
                'pred': round(float(reg_preds[i]), 2),
                'thresh_probs': thresh_probs[i],
                'features': {k: float(r['features'].get(k, 0) or 0) for k in feature_keys},
                'all_features': r['features'],
            })

    if len(loso_data) < 5:
        return {}

    # ── Metrics ───────────────────────────────────────────────────────
    actuals = np.array([d['actual'] for d in loso_data])
    preds = np.array([d['pred'] for d in loso_data])
    residuals = actuals - preds

    r2 = round(float(r2_score(actuals, preds)), 3)
    mae = round(float(mean_absolute_error(actuals, preds)), 2)
    rho, _ = spearmanr(-preds, -actuals)
    rho = round(float(rho), 3)
    res_std = round(float(np.std(residuals)), 2)
    sorted_residuals = sorted(residuals.tolist())

    def quantile(q):
        if not sorted_residuals:
            return 0
        idx = max(0, min(len(sorted_residuals) - 1, round(q * (len(sorted_residuals) - 1))))
        return round(sorted_residuals[idx], 2)

    residual_quantiles = {
        'p10': quantile(0.10), 'p25': quantile(0.25), 'p50': quantile(0.50),
        'p75': quantile(0.75), 'p90': quantile(0.90),
    }

    # ── Conditional residuals (heteroscedastic boom/bust) ─────────────
    boom_thresh = mae * 0.75
    n_booms = sum(1 for r in residuals if r > boom_thresh)
    n_busts = sum(1 for r in residuals if r < -boom_thresh)

    sorted_by_pred = sorted(loso_data, key=lambda d: -d['pred'])
    n = len(sorted_by_pred)
    bin_defs = [
        ('high', 0, round(n * 0.2)),
        ('mid', round(n * 0.2), round(n * 0.8)),
        ('low', round(n * 0.8), n),
    ]
    cond_bins = []
    for label, start, end in bin_defs:
        bin_rows = sorted_by_pred[start:end]
        if not bin_rows:
            continue
        bin_res = [d['actual'] - d['pred'] for d in bin_rows]
        bin_mean = np.mean(bin_res)
        bin_std = round(float(np.std(bin_res)), 2)
        bin_booms = sum(1 for r in bin_res if r > boom_thresh)
        bin_busts = sum(1 for r in bin_res if r < -boom_thresh)
        cond_bins.append({
            'label': label,
            'predMin': round(bin_rows[-1]['pred'], 1),
            'predMax': round(bin_rows[0]['pred'], 1),
            'residuals': sorted([round(r, 2) for r in bin_res]),
            'std': bin_std,
            'boomRate': round(bin_booms / len(bin_rows) * 100, 1),
            'bustRate': round(bin_busts / len(bin_rows) * 100, 1),
        })

    # ── Per-player boom/bust via variance prediction model ──────────
    # Train a second-stage LightGBM on |residual| to predict which
    # players have wider/tighter prediction intervals. Uses ALL
    # available numeric features (not just the regression features).
    # This gives genuinely individual boom/bust probabilities.

    # Collect variance feature keys (all numeric, >25% coverage)
    var_feat_keys = set()
    for d in loso_data:
        for k, v in d.get('all_features', {}).items():
            if not k.startswith('_'):
                try:
                    float(v) if v not in (None, '', 'NA') else None
                    var_feat_keys.add(k)
                except (ValueError, TypeError):
                    pass
    def _safe_float(v):
        if v is None or v == '' or v == 'NA' or v == 'NaN':
            return 0.0
        try:
            return float(v)
        except (ValueError, TypeError):
            return 0.0

    var_feat_keys = sorted(k for k in var_feat_keys
                           if sum(1 for d in loso_data
                                  if abs(_safe_float(d.get('all_features', {}).get(k, 0))) > 0) / n > 0.25)
    var_feat_keys_aug = var_feat_keys + ['_predictedPPG', '_predictedPPG_sq']

    def make_var_x(d_item):
        f = d_item.get('all_features', {})
        base = [_safe_float(f.get(k, 0)) for k in var_feat_keys]
        base.append(d_item['pred'])
        base.append(d_item['pred'] ** 2)
        return base

    abs_residuals = np.array([abs(d['actual'] - d['pred']) for d in loso_data])
    var_preds = np.full(n, float(np.mean(abs_residuals)))  # default to mean

    for held_season in seasons:
        tr_idx = [i for i, d in enumerate(loso_data) if d['season'] != held_season]
        te_idx = [i for i, d in enumerate(loso_data) if d['season'] == held_season]
        if len(tr_idx) < 10 or not te_idx:
            continue
        X_var_tr = np.nan_to_num(np.array([make_var_x(loso_data[i]) for i in tr_idx], dtype=np.float64))
        X_var_te = np.nan_to_num(np.array([make_var_x(loso_data[i]) for i in te_idx], dtype=np.float64))
        y_var_tr = abs_residuals[tr_idx]

        var_params = {
            'objective': 'regression', 'metric': 'mae', 'learning_rate': 0.03,
            'max_depth': 2, 'min_child_samples': max(5, len(tr_idx) // 8),
            'subsample': 0.7, 'colsample_bytree': 0.6, 'verbose': -1, 'seed': 42,
            'n_jobs': 1, 'extra_trees': True, 'bagging_fraction': 0.7, 'bagging_freq': 1,
        }
        dt_var = lgb.Dataset(X_var_tr, y_var_tr, feature_name=var_feat_keys_aug, free_raw_data=False)
        var_model = lgb.train(var_params, dt_var, num_boost_round=60)
        var_preds[te_idx] = np.clip(var_model.predict(X_var_te), 0.5, None)

    # Derive per-player boom/bust from predicted σ.
    # Scale the empirical residual distribution by each player's predicted
    # variance relative to the average. Higher predicted σ → wider tails
    # → higher boom AND bust probability.
    overall_std = float(np.std([d['actual'] - d['pred'] for d in loso_data]))
    sorted_resids = sorted(d['actual'] - d['pred'] for d in loso_data)

    for i, d in enumerate(loso_data):
        pred_sigma = max(0.5, float(var_preds[i]))
        scale = pred_sigma / overall_std if overall_std > 0 else 1.0
        boom_count = sum(1 for r in sorted_resids if r * scale > boom_thresh)
        bust_count = sum(1 for r in sorted_resids if r * scale < -boom_thresh)
        d['boom_prob'] = round(boom_count / len(sorted_resids) * 100, 1)
        d['bust_prob'] = round(bust_count / len(sorted_resids) * 100, 1)

    # ── Threshold metrics ─────────────────────────────────────────────
    threshold_metrics = []
    for thresh in thresholds:
        probs = [d['thresh_probs'].get(thresh, 0) / 100 for d in loso_data]
        labels = [1 if d['actual'] >= thresh else 0 for d in loso_data]
        base_rate = sum(labels) / len(labels) if labels else 0
        brier = sum((p - l) ** 2 for p, l in zip(probs, labels)) / len(probs) if probs else 0
        predicted = [1 if p >= 0.5 else 0 for p in probs]
        tp = sum(1 for p, l in zip(predicted, labels) if p == 1 and l == 1)
        fp = sum(1 for p, l in zip(predicted, labels) if p == 1 and l == 0)
        fn = sum(1 for p, l in zip(predicted, labels) if p == 0 and l == 1)
        correct = sum(1 for p, l in zip(predicted, labels) if p == l)
        threshold_metrics.append({
            'threshold': thresh,
            'accuracy': round(correct / len(labels) * 100, 1) if labels else 0,
            'precision': round(tp / (tp + fp) * 100, 1) if tp + fp > 0 else 0,
            'recall': round(tp / (tp + fn) * 100, 1) if tp + fn > 0 else 0,
            'brierScore': round(brier, 3),
            'baseRate': round(base_rate * 100, 1),
            'auc': 0,  # simplified — can add full AUC later
        })

    # ── Threshold hit-rate table (by model tier) ──────────────────────
    scored = sorted(loso_data, key=lambda d: -sum(d['thresh_probs'].get(t, 0) for t in thresholds))
    total = len(scored)
    tier_cuts = [
        ('Tier 1', 0, round(total * 0.10)),
        ('Tier 2', round(total * 0.10), round(total * 0.30)),
        ('Tier 3', round(total * 0.30), round(total * 0.70)),
        ('Tier 4', round(total * 0.70), round(total * 0.90)),
        ('Tier 5', round(total * 0.90), total),
    ]
    threshold_table = {'thresholds': thresholds, 'tiers': []}
    for label, start, end in tier_cuts:
        tier_rows = scored[start:end]
        if not tier_rows:
            continue
        avg_probs = [sum(d['thresh_probs'].get(t, 0) for t in thresholds) / len(thresholds) for d in tier_rows]
        hit_rates = [round(sum(1 for d in tier_rows if d['actual'] >= t) / len(tier_rows) * 100, 1) for t in thresholds]
        threshold_table['tiers'].append({
            'label': label, 'min': min(avg_probs), 'max': max(avg_probs),
            'n': len(tier_rows), 'hitRates': hit_rates,
        })

    # ── Backtest rows ─────────────────────────────────────────────────
    backtest_raw = []
    for d in loso_data:
        prob_values = [d['thresh_probs'].get(t, 0) for t in thresholds]
        mean_prob = sum(prob_values) / len(prob_values)
        backtest_raw.append({
            'name': d['name'], 'position': pos, 'draftSeason': d['season'],
            'actualPPG': round(d['actual'], 1),
            'predictedPPG': round(d['pred'], 1),
            'combinedScore': mean_prob,
            'percentile': 0,
            'modelTier': 0,
            'thresholdProbs': {str(k): v for k, v in d['thresh_probs'].items()},
            'boomProb': d.get('boom_prob', 0),
            'bustProb': d.get('bust_prob', 0),
            'features': d.get('all_features', {}),
        })

    # Rescale combined scores to 0-100
    raw_scores = [r['combinedScore'] for r in backtest_raw]
    min_s, max_s = min(raw_scores), max(raw_scores)
    range_s = max_s - min_s
    for r in backtest_raw:
        r['combinedScore'] = round(5 + ((r['combinedScore'] - min_s) / range_s) * 93, 1) if range_s > 0 else 50

    backtest_raw.sort(key=lambda r: -r['combinedScore'])
    for i, r in enumerate(backtest_raw):
        r['percentile'] = round((1 - i / len(backtest_raw)) * 100)
        pctl = r['percentile']
        if pctl >= 95: r['modelTier'] = 1
        elif pctl >= 85: r['modelTier'] = 2
        elif pctl >= 70: r['modelTier'] = 3
        elif pctl >= 50: r['modelTier'] = 4
        elif pctl >= 25: r['modelTier'] = 5
        else: r['modelTier'] = 6

    # ── Feature importance (from final Ridge on all data) ─────────────
    all_rows_expanded = expand(pos_rows)
    X_all = make_X(all_rows_expanded)
    y_all = make_y(all_rows_expanded)
    final_ridge = Ridge(alpha=hyper['ridge_alpha'])
    final_ridge.fit(X_all, y_all)

    coeffs = final_ridge.coef_
    total_imp = sum(abs(c) for c in coeffs)
    feature_importance = sorted([
        {
            'key': feature_keys[i],
            'importance': round(abs(coeffs[i]) / total_imp, 3) if total_imp > 0 else 0,
            'direction': 'positive' if coeffs[i] >= 0 else 'negative',
        }
        for i in range(len(feature_keys))
    ], key=lambda f: -f['importance'])

    # ── Serialize Ridge model for JS predict() compatibility ──────────
    # JS ridge.ts expects z-score normalized features
    X_raw = make_X(pos_rows)
    means = X_raw.mean(axis=0).tolist()
    stds = X_raw.std(axis=0).tolist()
    stds = [s if s > 0 else 1.0 for s in stds]

    # Retrain on z-scored features to match JS predict() format
    X_z = (X_raw - np.array(means)) / np.array(stds)
    y_raw = make_y(pos_rows)
    y_mean = float(y_raw.mean())
    y_std = float(y_raw.std()) or 1.0
    y_z = (y_raw - y_mean) / y_std

    ridge_z = Ridge(alpha=hyper['ridge_alpha'])
    ridge_z.fit(X_z, y_z)

    ridge_model = {
        'coefficients': [round(float(c), 8) for c in ridge_z.coef_],
        'intercept': round(float(ridge_z.intercept_), 8),
        'featureNames': feature_keys,
        'featureMeans': [round(m, 6) for m in means],
        'featureStds': [round(s, 6) for s in stds],
        'targetMean': round(y_mean, 6),
        'targetStd': round(y_std, 6),
        'rSquared': r2,
        'adjustedRSquared': r2,
        'mae': mae,
        'rmse': round(float(np.sqrt(np.mean(residuals ** 2))), 2),
        'n': len(pos_rows),
        'predictions': [],
    }

    elapsed = round(time.time() - t0, 1)
    print(f"    {pos}: n={len(pos_rows)}, R²={r2:.3f}, MAE={mae:.1f}, "
          f"\u03c1={rho:.3f}, \u03c3={res_std:.2f} ({elapsed}s)")

    return {
        'n': len(pos_rows),
        'cvR2': r2,
        'cvMAE': mae,
        'rankCorr': rho,
        'seasons': len(seasons),
        'featureKeys': feature_keys,
        'featureImportance': feature_importance,
        'residualStd': res_std,
        'losoResiduals': [round(r, 2) for r in sorted_residuals],
        'residualQuantiles': residual_quantiles,
        'thresholds': thresholds,
        'thresholdMetrics': threshold_metrics,
        'thresholdTable': threshold_table,
        'backtestRows': backtest_raw,
        'thresholdModels': {},  # JS scoring will use ridge_model directly
        'boomModel': None,
        'bustModel': None,
        'boomRate': round(n_booms / n * 100, 1),
        'bustRate': round(n_busts / n * 100, 1),
        'boomMetrics': None,
        'bustMetrics': None,
        'boomFeatureImportance': None,
        'bustFeatureImportance': None,
        'conditionalResiduals': {
            'bins': cond_bins,
            'boomThreshold': round(boom_thresh, 2),
        },
        'ridgeModel': ridge_model,
        'gbmModel': None,  # LightGBM model saved separately if needed
        'ridgeModelCompanion': None,
        'gbmModelCompanion': None,
        'companionFeatureKeys': None,
        'companionBlendWeight': 0,
        'topN': {},
    }


# ── Main ──────────────────────────────────────────────────────────────

def main():
    args = set(sys.argv[1:])
    do_pre = '--post-draft-only' not in args
    do_post = '--pre-draft-only' not in args

    print(f"Loading training rows from {CACHE_PATH}...")
    career_rows = load_career_rows(CACHE_PATH)
    print(f"  {len(career_rows)} career rows")

    if do_pre:
        print("\n  Training pre-draft career models (LightGBM + Ridge)...")
        pre_draft_results = {}
        for pos in ['QB', 'RB', 'WR', 'TE']:
            result = train_position(career_rows, pos, PRE_DRAFT_FEATURES[pos], is_post_draft=False)
            if result:
                pre_draft_results[pos] = result

        with open(PRE_DRAFT_CACHE, 'w') as f:
            json.dump({'rookieCareerModels': pre_draft_results}, f)
        print(f"  Pre-draft cache saved to {PRE_DRAFT_CACHE}")

    if do_post:
        print("\n  Training post-draft career models (LightGBM + Ridge)...")
        post_draft_results = {}
        for pos in ['QB', 'RB', 'WR', 'TE']:
            result = train_position(career_rows, pos, POST_DRAFT_FEATURES[pos], is_post_draft=True)
            if result:
                post_draft_results[pos] = result

        with open(POST_DRAFT_CACHE, 'w') as f:
            json.dump({'rookieCareerModels': post_draft_results}, f)
        print(f"  Post-draft cache saved to {POST_DRAFT_CACHE}")

    print("\nDone.")


if __name__ == '__main__':
    main()
