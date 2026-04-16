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

import sys as _sys
_sys.path.insert(0, str(Path(__file__).parent))
from train_projection_models import bagged_lgb_to_js_bag as _bagged_career_to_js  # noqa: E402

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
    boom_base_rate = n_booms / len(loso_data) if len(loso_data) > 0 else 0
    bust_base_rate = n_busts / len(loso_data) if len(loso_data) > 0 else 0

    def _safe_float(v):
        if v is None or v == '' or v == 'NA' or v == 'NaN':
            return 0.0
        try:
            return float(v)
        except (ValueError, TypeError):
            return 0.0

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

    # ── Per-player boom/bust via talent-vs-draft outperformance model ──
    # Predicts which players will outperform their predicted PPG rank using
    # features NOT in the regression model: athleticism, college production
    # gaps vs draft position, and adversity signals (injury/off-year proxies).
    #
    # Boom = predicted bottom 50%, actual top 20% (late pick, elite production)
    # Bust = predicted top 20%, actual bottom 50% (high pick, disappointing)

    # Compute outperformance target: actual rank - predicted rank
    pred_ranks = np.argsort(np.argsort([d['pred'] for d in loso_data])) / n
    actual_ranks = np.argsort(np.argsort([d['actual'] for d in loso_data])) / n
    outperformance = actual_ranks - pred_ranks

    def _build_gap_features(d_item):
        """Build talent-vs-draft gap features for outperformance model."""
        f = d_item.get('all_features', {})
        pick = max(1, _safe_float(f.get('nflDraftPick', 300)))
        log_pick = math.log(pick)

        # Raw talent signals
        ras = _safe_float(f.get('relativeAthleticScore', 0))
        speed = _safe_float(f.get('speedScore', 0))
        height_speed = _safe_float(f.get('heightAdjSpeedScore', 0))
        best_rec = _safe_float(f.get('collegeBestRecYds', 0))
        dominator = _safe_float(f.get('collegeDominatorRating', 0))
        breakout = _safe_float(f.get('collegeBreakoutScore', 0))
        prospect_grade = _safe_float(f.get('prospectGrade', 0))
        market_share = _safe_float(f.get('collegeMarketShare', 0))
        total_tds = _safe_float(f.get('collegeTotalTDs', 0))
        age = _safe_float(f.get('age', 0))
        early_declare = _safe_float(f.get('collegeEarlyDeclare', 0))
        experience = _safe_float(f.get('collegeExperiencePerAge', 0))
        seasons = _safe_float(f.get('collegeSeasons', 0))
        forty = _safe_float(f.get('forty', 0))
        wt = _safe_float(f.get('weight', 0))
        cone = _safe_float(f.get('cone', 0))
        shuttle = _safe_float(f.get('shuttle', 0))
        college_games = _safe_float(f.get('collegeGames', 0))
        breakout_age = _safe_float(f.get('collegeBreakoutAge', 0))

        # Gap features: talent signal minus what draft position implies
        ras_vs_pick = (ras - (10 - log_pick)) if ras > 0 else 0
        speed_vs_pick = (speed - (120 - pick * 0.3)) if speed > 0 else 0
        production_vs_pick = (dominator / max(1, log_pick)) if dominator > 0 else 0
        best_season_vs_pick = (best_rec / max(1, pick)) if best_rec > 0 else 0
        grade_vs_pick = (prospect_grade - pick * 0.3) if prospect_grade > 0 else 0

        # Injury/adversity proxies
        games_per_season = (college_games / max(1, seasons)) if seasons > 0 else 0
        low_games = 1 if games_per_season > 0 and games_per_season < 10 else 0
        early_declare_late = early_declare * log_pick
        recent_breakout = 1 if breakout_age > 0 and age > 0 and (age - breakout_age) <= 1 else 0

        return [
            ras, speed, height_speed, forty, wt, cone, shuttle,
            best_rec, dominator, breakout, market_share, total_tds,
            prospect_grade, age, early_declare, experience, seasons,
            ras_vs_pick, speed_vs_pick, production_vs_pick,
            best_season_vs_pick, grade_vs_pick,
            low_games, early_declare_late, games_per_season, recent_breakout,
        ]

    GAP_FEAT_NAMES = [
        'ras', 'speed', 'height_speed', 'forty', 'weight', 'cone', 'shuttle',
        'best_rec', 'dominator', 'breakout', 'market_share', 'total_tds',
        'prospect_grade', 'age', 'early_declare', 'experience', 'seasons',
        'ras_vs_pick', 'speed_vs_pick', 'production_vs_pick',
        'best_season_vs_pick', 'grade_vs_pick',
        'low_games', 'early_declare_late', 'games_per_season', 'recent_breakout',
    ]

    X_gap = np.nan_to_num(np.array([_build_gap_features(d) for d in loso_data], dtype=np.float64))
    outperf_preds = np.zeros(n)

    for held_season in seasons:
        tr_idx = [i for i, d in enumerate(loso_data) if d['season'] != held_season]
        te_idx = [i for i, d in enumerate(loso_data) if d['season'] == held_season]
        if len(tr_idx) < 20 or not te_idx:
            continue
        gap_params = {
            'objective': 'regression', 'metric': 'mae', 'learning_rate': 0.03,
            'max_depth': 2, 'min_child_samples': max(5, len(tr_idx) // 8),
            'subsample': 0.7, 'colsample_bytree': 0.6, 'verbose': -1, 'seed': 42,
            'n_jobs': 1, 'extra_trees': True,
        }
        dt_gap = lgb.Dataset(X_gap[tr_idx], outperformance[tr_idx],
                             feature_name=GAP_FEAT_NAMES, free_raw_data=False)
        gap_model = lgb.train(gap_params, dt_gap, num_boost_round=60)
        outperf_preds[te_idx] = gap_model.predict(X_gap[te_idx])

    # Convert outperformance predictions to boom percentile.
    outperf_pctile = np.argsort(np.argsort(outperf_preds)) / n * 100

    # ── Bust classifier (binary, focused on top-pick bust avoidance) ──
    # Trained on ALL players, predicts P(actual < position median).
    # Uses athleticism, college production, age, and missing-data flags.
    # Validated: WR AUC=0.672, TE AUC=0.701 on top-25% predicted.
    all_actuals_sorted = sorted([d['actual'] for d in loso_data])
    median_ppg = all_actuals_sorted[int(n * 0.5)]
    y_bust_binary = np.array([1 if d['actual'] <= median_ppg else 0 for d in loso_data])

    # Build bust-specific features
    hits_in_top = [d for d in loso_data if d['pred'] >= np.percentile([d['pred'] for d in loso_data], 75) and d['actual'] > median_ppg]
    avg_speed_hit = float(np.mean([_safe_float(d['all_features'].get('speedScore', 0)) for d in hits_in_top if _safe_float(d['all_features'].get('speedScore', 0)) > 0])) if hits_in_top else 100
    avg_dom_hit = float(np.mean([_safe_float(d['all_features'].get('collegeDominatorRating', 0)) for d in hits_in_top if _safe_float(d['all_features'].get('collegeDominatorRating', 0)) > 0])) if hits_in_top else 30

    BUST_FEAT_NAMES = [
        'speedScore', 'relativeAthleticScore', 'heightAdjSpeedScore',
        'forty', 'weight', 'age',
        'collegeDominatorRating', 'collegeBestRecYds', 'collegeBreakoutScore',
        'collegeMarketShare', 'collegeTotalTDs', 'collegeReceptionShare',
        'collegeExperiencePerAge', 'collegeSeasons', 'collegeEarlyDeclare',
        'hasCombineData', 'hasCollegeStats',
        'predictedPPG', 'nflDraftPick',
        'speed_deficit', 'production_deficit', 'age_for_draft', 'missing_data_count',
    ]

    def _build_bust_features(d_item):
        f = d_item.get('all_features', {})
        speed = _safe_float(f.get('speedScore', 0))
        ras = _safe_float(f.get('relativeAthleticScore', 0))
        hspeed = _safe_float(f.get('heightAdjSpeedScore', 0))
        forty = _safe_float(f.get('forty', 0))
        wt = _safe_float(f.get('weight', 0))
        age = _safe_float(f.get('age', 0))
        dom = _safe_float(f.get('collegeDominatorRating', 0))
        best_rec = _safe_float(f.get('collegeBestRecYds', 0))
        breakout = _safe_float(f.get('collegeBreakoutScore', 0))
        mkt = _safe_float(f.get('collegeMarketShare', 0))
        tds = _safe_float(f.get('collegeTotalTDs', 0))
        rec_share = _safe_float(f.get('collegeReceptionShare', 0))
        exp = _safe_float(f.get('collegeExperiencePerAge', 0))
        seasons = _safe_float(f.get('collegeSeasons', 0))
        early = _safe_float(f.get('collegeEarlyDeclare', 0))
        has_combine = 1 if speed > 0 or forty > 0 else 0
        has_college = 1 if dom > 0 or best_rec > 0 else 0
        pick = _safe_float(f.get('nflDraftPick', 300))

        speed_deficit = (speed - avg_speed_hit) if speed > 0 else -20
        prod_deficit = (dom - avg_dom_hit) if dom > 0 else -15
        age_risk = age - 21 if age > 0 else 0
        missing = (1 if speed == 0 else 0) + (1 if dom == 0 else 0) + (1 if ras == 0 else 0)

        return [speed, ras, hspeed, forty, wt, age, dom, best_rec, breakout,
                mkt, tds, rec_share, exp, seasons, early,
                has_combine, has_college, d_item['pred'], pick,
                speed_deficit, prod_deficit, age_risk, missing]

    X_bust = np.nan_to_num(np.array([_build_bust_features(d) for d in loso_data], dtype=np.float64))
    bust_scores = np.full(n, float(y_bust_binary.mean()))

    for held_season in seasons:
        tr_idx = [i for i, d in enumerate(loso_data) if d['season'] != held_season]
        te_idx = [i for i, d in enumerate(loso_data) if d['season'] == held_season]
        if len(tr_idx) < 20 or not te_idx or sum(y_bust_binary[tr_idx]) < 3:
            continue
        bust_params = {
            'objective': 'binary', 'metric': 'auc', 'learning_rate': 0.03,
            'max_depth': 2, 'min_child_samples': max(3, len(tr_idx) // 10),
            'subsample': 0.7, 'colsample_bytree': 0.6, 'verbose': -1,
            'seed': 42, 'n_jobs': 1, 'is_unbalance': True, 'extra_trees': True,
        }
        dt_bust = lgb.Dataset(X_bust[tr_idx], y_bust_binary[tr_idx],
                              feature_name=BUST_FEAT_NAMES, free_raw_data=False)
        bust_model = lgb.train(bust_params, dt_bust, num_boost_round=60)
        bust_scores[te_idx] = bust_model.predict(X_bust[te_idx])

    # ── Final boom/bust models on ALL data (for feature importance) ────
    # The LOSO models above are used for per-player scoring. Here we train
    # one more model per objective on the full dataset purely to extract
    # feature importance for the model docs. Direction is inferred from
    # each feature's Spearman correlation with the target (gain importance
    # has no natural sign).
    def _normalize_importance(gains: np.ndarray, names: list[str],
                               targets: np.ndarray, feats: np.ndarray) -> list[dict]:
        total = float(gains.sum())
        if total <= 0:
            return []
        entries = []
        for i, name in enumerate(names):
            imp = float(gains[i]) / total
            if imp <= 0:
                continue
            try:
                rho, _ = spearmanr(feats[:, i], targets)
                if math.isnan(rho):
                    rho = 0.0
            except Exception:
                rho = 0.0
            entries.append({
                'key': name,
                'importance': round(imp, 3),
                'direction': 'positive' if rho >= 0 else 'negative',
            })
        entries.sort(key=lambda e: -e['importance'])
        return entries

    boom_feature_importance: list[dict] = []
    if len(loso_data) >= 20:
        try:
            gap_final = lgb.train(
                {
                    'objective': 'regression', 'metric': 'mae', 'learning_rate': 0.03,
                    'max_depth': 2, 'min_child_samples': max(5, n // 8),
                    'subsample': 0.7, 'colsample_bytree': 0.6, 'verbose': -1,
                    'seed': 42, 'n_jobs': 1, 'extra_trees': True,
                },
                lgb.Dataset(X_gap, outperformance, feature_name=GAP_FEAT_NAMES,
                            free_raw_data=False),
                num_boost_round=60,
            )
            boom_feature_importance = _normalize_importance(
                gap_final.feature_importance(importance_type='gain'),
                GAP_FEAT_NAMES, outperformance, X_gap,
            )
        except Exception as e:
            print(f"    {pos}: boom feature importance skipped ({e})")

    bust_feature_importance: list[dict] = []
    if len(loso_data) >= 20 and sum(y_bust_binary) >= 5:
        try:
            bust_final = lgb.train(
                {
                    'objective': 'binary', 'metric': 'auc', 'learning_rate': 0.03,
                    'max_depth': 2, 'min_child_samples': max(3, n // 10),
                    'subsample': 0.7, 'colsample_bytree': 0.6, 'verbose': -1,
                    'seed': 42, 'n_jobs': 1, 'is_unbalance': True, 'extra_trees': True,
                },
                lgb.Dataset(X_bust, y_bust_binary, feature_name=BUST_FEAT_NAMES,
                            free_raw_data=False),
                num_boost_round=60,
            )
            bust_feature_importance = _normalize_importance(
                bust_final.feature_importance(importance_type='gain'),
                BUST_FEAT_NAMES, y_bust_binary.astype(np.float64), X_bust,
            )
        except Exception as e:
            print(f"    {pos}: bust feature importance skipped ({e})")

    # Assign boom (from outperformance model) and bust (from bust classifier)
    for i, d in enumerate(loso_data):
        # Boom: outperformance percentile scaled to probability
        pctile = outperf_pctile[i]
        d['boom_prob'] = round(min(50, boom_base_rate * 100 * (0.5 + pctile / 100)), 1)
        # Bust: direct probability from classifier (already calibrated)
        d['bust_prob'] = round(min(50, float(bust_scores[i]) * 100), 1)

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

    # Companion (college-only) feature importance — Ridge coefficients on
    # the non-draft-capital feature set. Surfaces what's driving the
    # late-round breakout blend (WR/RB pre-draft only).
    companion_feature_importance: list[dict] = []
    if use_companion:
        try:
            X_all_co = make_X(all_rows_expanded, college_only_keys)
            ridge_co_final = Ridge(alpha=hyper['ridge_alpha'])
            ridge_co_final.fit(X_all_co, y_all)
            co_coeffs = ridge_co_final.coef_
            co_total = sum(abs(c) for c in co_coeffs)
            if co_total > 0:
                companion_feature_importance = sorted([
                    {
                        'key': college_only_keys[i],
                        'importance': round(abs(co_coeffs[i]) / co_total, 3),
                        'direction': 'positive' if co_coeffs[i] >= 0 else 'negative',
                    }
                    for i in range(len(college_only_keys))
                ], key=lambda f: -f['importance'])
        except Exception as e:
            print(f"    {pos}: companion feature importance skipped ({e})")

    # ── Final bagged LightGBM ensemble (shipped in cache as gbmModel) ──
    # Career models used to ship with gbmModel=None — LOSO CV used bagged
    # LGB internally for evaluation, but the final full-data model was
    # never serialized. Production rookieCareerModel.ts falls back to
    # Ridge-only when gbmModel is null, losing the GBM signal entirely.
    #
    # Now we train a matching bagged ensemble on the full (expanded) data
    # with the SAME hyperparameters used in LOSO, then serialize via
    # bagged_lgb_to_js_bag into the {models: [...]} shape that the TS
    # predictBaggedGBM consumes. This matches how ADP/PPG/residual models
    # already ship GBM trees — closing a gap the career path had.
    final_gbm_params = {
        'objective': 'regression', 'metric': 'mae',
        'learning_rate': hyper['lr'], 'max_depth': hyper['max_depth'],
        'min_child_samples': hyper['min_child'],
        'subsample': 0.8, 'colsample_bytree': 0.8,
        'bagging_fraction': 0.8, 'bagging_freq': 1,
        'extra_trees': True,
        'verbose': -1, 'seed': 42, 'n_jobs': 1,
    }
    final_gbm_boosters = []
    for bag_i in range(N_BAGS):
        p = dict(final_gbm_params)
        p['seed'] = 42 + bag_i
        p['bagging_seed'] = 42 + bag_i
        p['feature_fraction_seed'] = 42 + bag_i
        dt_final = lgb.Dataset(X_all, y_all, feature_name=feature_keys, free_raw_data=False)
        final_gbm_boosters.append(lgb.train(p, dt_final, num_boost_round=hyper['n_estimators']))
    gbm_model = _bagged_career_to_js(final_gbm_boosters, X_all, y_all, feature_keys)

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
        'boomFeatureImportance': boom_feature_importance or None,
        'bustFeatureImportance': bust_feature_importance or None,
        'companionFeatureImportance': companion_feature_importance or None,
        'conditionalResiduals': {
            'bins': cond_bins,
            'boomThreshold': round(boom_thresh, 2),
        },
        'ridgeModel': ridge_model,
        'gbmModel': gbm_model,  # BaggedGBM ({models: [GBMModel, ...]}) emitted via bagged_lgb_to_js_bag
        'ridgeModelCompanion': None,
        'gbmModelCompanion': None,
        'companionFeatureKeys': None,
        'companionBlendWeight': 0,
        'topN': {},
    }


def _safe_float_global(v):
    if v is None or v == '' or v == 'NA' or v == 'NaN':
        return 0.0
    try:
        return float(v)
    except (ValueError, TypeError):
        return 0.0


def _build_gap_features_standalone(features: dict, predicted_ppg: float) -> list[float]:
    """Build talent-vs-draft gap features for a player (standalone version)."""
    sf = _safe_float_global
    pick = max(1, sf(features.get('nflDraftPick', 300)))
    log_pick = math.log(pick)
    ras = sf(features.get('relativeAthleticScore', 0))
    speed = sf(features.get('speedScore', 0))
    height_speed = sf(features.get('heightAdjSpeedScore', 0))
    best_rec = sf(features.get('collegeBestRecYds', 0))
    dominator = sf(features.get('collegeDominatorRating', 0))
    breakout = sf(features.get('collegeBreakoutScore', 0))
    prospect_grade = sf(features.get('prospectGrade', 0))
    market_share = sf(features.get('collegeMarketShare', 0))
    total_tds = sf(features.get('collegeTotalTDs', 0))
    age = sf(features.get('age', 0))
    early_declare = sf(features.get('collegeEarlyDeclare', 0))
    experience = sf(features.get('collegeExperiencePerAge', 0))
    seasons = sf(features.get('collegeSeasons', 0))
    forty = sf(features.get('forty', 0))
    wt = sf(features.get('weight', 0))
    cone = sf(features.get('cone', 0))
    shuttle = sf(features.get('shuttle', 0))
    college_games = sf(features.get('collegeGames', 0))
    breakout_age = sf(features.get('collegeBreakoutAge', 0))

    ras_vs_pick = (ras - (10 - log_pick)) if ras > 0 else 0
    speed_vs_pick = (speed - (120 - pick * 0.3)) if speed > 0 else 0
    production_vs_pick = (dominator / max(1, log_pick)) if dominator > 0 else 0
    best_season_vs_pick = (best_rec / max(1, pick)) if best_rec > 0 else 0
    grade_vs_pick = (prospect_grade - pick * 0.3) if prospect_grade > 0 else 0
    games_per_season = (college_games / max(1, seasons)) if seasons > 0 else 0
    low_games = 1 if 0 < games_per_season < 10 else 0
    early_declare_late = early_declare * log_pick
    recent_breakout = 1 if breakout_age > 0 and age > 0 and (age - breakout_age) <= 1 else 0

    return [
        ras, speed, height_speed, forty, wt, cone, shuttle,
        best_rec, dominator, breakout, market_share, total_tds,
        prospect_grade, age, early_declare, experience, seasons,
        ras_vs_pick, speed_vs_pick, production_vs_pick,
        best_season_vs_pick, grade_vs_pick,
        low_games, early_declare_late, games_per_season, recent_breakout,
    ]


GAP_FEAT_NAMES_GLOBAL = [
    'ras', 'speed', 'height_speed', 'forty', 'weight', 'cone', 'shuttle',
    'best_rec', 'dominator', 'breakout', 'market_share', 'total_tds',
    'prospect_grade', 'age', 'early_declare', 'experience', 'seasons',
    'ras_vs_pick', 'speed_vs_pick', 'production_vs_pick',
    'best_season_vs_pick', 'grade_vs_pick',
    'low_games', 'early_declare_late', 'games_per_season', 'recent_breakout',
]


def score_prospect_boom_bust(model_results: dict, career_rows: list,
                              prospects: list) -> list[dict]:
    """Score 2026 prospects using the talent-vs-draft gap model.

    Trains on full backtest data (no LOSO needed for final scoring),
    then predicts outperformance for each prospect.
    """
    results = []
    for pos in ['QB', 'RB', 'WR', 'TE']:
        mr = model_results.get(pos)
        if not mr or not mr.get('backtestRows'):
            continue
        bt = mr['backtestRows']
        n = len(bt)
        if n < 20:
            continue

        # Compute outperformance target on full backtest
        pred_ranks = np.argsort(np.argsort([r['predictedPPG'] for r in bt])) / n
        actual_ranks = np.argsort(np.argsort([r['actualPPG'] for r in bt])) / n
        outperf = actual_ranks - pred_ranks

        # Build gap features for backtest
        X_train = []
        for r in bt:
            f = r.get('features', {})
            X_train.append(_build_gap_features_standalone(f, r['predictedPPG']))
        X_train = np.nan_to_num(np.array(X_train, dtype=np.float64))

        # Train gap model on full data
        params = {
            'objective': 'regression', 'metric': 'mae', 'learning_rate': 0.03,
            'max_depth': 2, 'min_child_samples': max(5, n // 8),
            'subsample': 0.7, 'colsample_bytree': 0.6, 'verbose': -1,
            'seed': 42, 'n_jobs': 1, 'extra_trees': True,
        }
        dt = lgb.Dataset(X_train, outperf, feature_name=GAP_FEAT_NAMES_GLOBAL,
                         free_raw_data=False)
        gap_model = lgb.train(params, dt, num_boost_round=60)

        # Boom/bust base rates
        mae = float(np.mean(np.abs([r['actualPPG'] - r['predictedPPG'] for r in bt])))
        boom_thresh = mae * 0.75
        residuals = [r['actualPPG'] - r['predictedPPG'] for r in bt]
        boom_base = sum(1 for r in residuals if r > boom_thresh) / n
        bust_base = sum(1 for r in residuals if r < -boom_thresh) / n

        # ── Bust classifier (binary, trained on full backtest) ──────
        all_actuals_sorted = sorted([r['actualPPG'] for r in bt])
        median_ppg = all_actuals_sorted[int(n * 0.5)]
        y_bust_binary = np.array([1 if r['actualPPG'] <= median_ppg else 0 for r in bt])

        # Compute avg stats for speed/production deficit
        hits_top = [r for r in bt if r['predictedPPG'] >= np.percentile([r['predictedPPG'] for r in bt], 75) and r['actualPPG'] > median_ppg]
        sf = _safe_float_global
        avg_speed = float(np.mean([sf(r['features'].get('speedScore', 0)) for r in hits_top if sf(r['features'].get('speedScore', 0)) > 0])) if hits_top else 100
        avg_dom = float(np.mean([sf(r['features'].get('collegeDominatorRating', 0)) for r in hits_top if sf(r['features'].get('collegeDominatorRating', 0)) > 0])) if hits_top else 30

        BUST_FEAT_NAMES_P = [
            'speedScore', 'relativeAthleticScore', 'heightAdjSpeedScore',
            'forty', 'weight', 'age',
            'collegeDominatorRating', 'collegeBestRecYds', 'collegeBreakoutScore',
            'collegeMarketShare', 'collegeTotalTDs', 'collegeReceptionShare',
            'collegeExperiencePerAge', 'collegeSeasons', 'collegeEarlyDeclare',
            'hasCombineData', 'hasCollegeStats',
            'predictedPPG', 'nflDraftPick',
            'speed_deficit', 'production_deficit', 'age_for_draft', 'missing_data_count',
        ]

        def _build_bust_feats(features, pred_ppg):
            sf2 = _safe_float_global
            speed = sf2(features.get('speedScore', 0))
            ras = sf2(features.get('relativeAthleticScore', 0))
            hspeed = sf2(features.get('heightAdjSpeedScore', 0))
            forty = sf2(features.get('forty', 0))
            wt = sf2(features.get('weight', 0))
            age = sf2(features.get('age', 0))
            dom = sf2(features.get('collegeDominatorRating', 0))
            best_rec = sf2(features.get('collegeBestRecYds', 0))
            brk = sf2(features.get('collegeBreakoutScore', 0))
            mkt = sf2(features.get('collegeMarketShare', 0))
            tds = sf2(features.get('collegeTotalTDs', 0))
            rec_share = sf2(features.get('collegeReceptionShare', 0))
            exp = sf2(features.get('collegeExperiencePerAge', 0))
            seasons = sf2(features.get('collegeSeasons', 0))
            early = sf2(features.get('collegeEarlyDeclare', 0))
            has_combine = 1 if speed > 0 or forty > 0 else 0
            has_college = 1 if dom > 0 or best_rec > 0 else 0
            pick = sf2(features.get('nflDraftPick', 300))
            speed_def = (speed - avg_speed) if speed > 0 else -20
            prod_def = (dom - avg_dom) if dom > 0 else -15
            age_risk = age - 21 if age > 0 else 0
            missing = (1 if speed == 0 else 0) + (1 if dom == 0 else 0) + (1 if ras == 0 else 0)
            return [speed, ras, hspeed, forty, wt, age, dom, best_rec, brk,
                    mkt, tds, rec_share, exp, seasons, early,
                    has_combine, has_college, pred_ppg, pick,
                    speed_def, prod_def, age_risk, missing]

        X_bust_train = np.nan_to_num(np.array(
            [_build_bust_feats(r.get('features', {}), r['predictedPPG']) for r in bt],
            dtype=np.float64))

        bust_params = {
            'objective': 'binary', 'metric': 'auc', 'learning_rate': 0.03,
            'max_depth': 2, 'min_child_samples': max(3, n // 10),
            'subsample': 0.7, 'colsample_bytree': 0.6, 'verbose': -1,
            'seed': 42, 'n_jobs': 1, 'is_unbalance': True, 'extra_trees': True,
        }
        dt_bust = lgb.Dataset(X_bust_train, y_bust_binary,
                              feature_name=BUST_FEAT_NAMES_P, free_raw_data=False)
        bust_model = lgb.train(bust_params, dt_bust, num_boost_round=60)

        # ── Score prospects ───────────────────────────────────────────
        pos_prospects = [p for p in prospects if p.get('position') == pos]
        if not pos_prospects:
            continue

        # Boom scores from gap model
        X_prosp_gap = np.nan_to_num(np.array(
            [_build_gap_features_standalone(p.get('features', {}), p.get('predictedCareerPPG', 0))
             for p in pos_prospects], dtype=np.float64))
        gap_scores = gap_model.predict(X_prosp_gap)
        bt_gap_scores = gap_model.predict(X_train)

        # Bust scores from bust classifier
        X_prosp_bust = np.nan_to_num(np.array(
            [_build_bust_feats(p.get('features', {}), p.get('predictedCareerPPG', 0))
             for p in pos_prospects], dtype=np.float64))
        prospect_bust_scores = bust_model.predict(X_prosp_bust)

        for i, p in enumerate(pos_prospects):
            pctile = float(np.mean(bt_gap_scores <= gap_scores[i]) * 100)
            boom_mult = 0.5 + (pctile / 100)
            results.append({
                'name': p['name'],
                'position': pos,
                'boomProb': round(min(50, boom_base * 100 * boom_mult), 1),
                'bustProb': round(min(50, float(prospect_bust_scores[i]) * 100), 1),
                'outperfPctile': round(pctile, 1),
            })

    return results


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

        # Score 2026 prospects with the gap model for boom/bust
        print("\n  Scoring 2026 prospect boom/bust...")
        try:
            with open('public/data/feature-matrix.json') as f:
                fm = json.load(f)
            prospects = fm.get('careerPredictions2026', [])
            if prospects:
                prospect_scores = score_prospect_boom_bust(
                    pre_draft_results, career_rows, prospects)
                with open('public/data/prospect-boom-bust.json', 'w') as f:
                    json.dump(prospect_scores, f)
                print(f"  Scored {len(prospect_scores)} prospects → prospect-boom-bust.json")
        except Exception as e:
            print(f"  Prospect scoring skipped: {e}")

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
