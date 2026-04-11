#!/usr/bin/env python3
"""
Train ADP, PPG, Residual, and Share models using LightGBM + scikit-learn.

Outputs JSON model caches in the exact format the TypeScript site expects.
The TS predict() and predictGBM() functions work unchanged.

Usage:
    python3 scripts/train_projection_models.py              # train all
    python3 scripts/train_projection_models.py --only share  # specific type
"""

import json
import sys
import time
import math
import warnings
from pathlib import Path

import numpy as np
import lightgbm as lgb
from sklearn.linear_model import Ridge
from sklearn.metrics import r2_score, mean_absolute_error
from scipy.stats import spearmanr

warnings.filterwarnings('ignore')

DATA_DIR = Path('public/data')
CACHE_PATH = DATA_DIR / 'training-rows-cache-v42.json'


# ── LightGBM → JS tree conversion ──────────────────────────────────

def _convert_node(node: dict) -> dict:
    """Convert LightGBM tree node to JS {featureIndex, threshold, value, left, right}."""
    if 'leaf_value' in node:
        return {'featureIndex': -1, 'threshold': 0, 'value': round(node['leaf_value'], 10), 'left': None, 'right': None}
    return {
        'featureIndex': node['split_feature'],
        'threshold': node['threshold'],
        'value': 0,
        'left': _convert_node(node['left_child']),
        'right': _convert_node(node['right_child']),
    }


def lgb_to_js_gbm(model: lgb.Booster, X: np.ndarray, y: np.ndarray,
                    feature_names: list[str], loss: str = 'squared', quantile: float | None = None) -> dict:
    """Convert trained LightGBM to JS-compatible GBM format."""
    dump = model.dump_model()
    trees = [_convert_node(t['tree_structure']) for t in dump['tree_info']]
    preds = model.predict(X)
    r2 = float(r2_score(y, preds))
    mae_val = float(mean_absolute_error(y, preds))
    rmse = float(np.sqrt(np.mean((y - preds) ** 2)))
    n = len(y)
    return {
        'trees': trees,
        'initialPrediction': float(np.mean(y)),
        'learningRate': float(model.params.get('learning_rate', 0.05)),
        'featureNames': feature_names,
        'rSquared': round(r2, 6),
        'adjustedRSquared': round(1 - (1 - r2) * (n - 1) / max(1, n - len(feature_names) - 1), 6),
        'mae': round(mae_val, 4),
        'rmse': round(rmse, 4),
        'n': n,
        'predictions': [round(float(p), 4) for p in preds],
        'loss': loss,
        **(({'quantile': quantile} if quantile is not None else {})),
    }


def train_ridge_js(X: np.ndarray, y: np.ndarray, feature_names: list[str], alpha: float) -> dict:
    """Train Ridge and output JS-compatible format (with standardization)."""
    means = np.nanmean(X, axis=0)
    stds = np.nanstd(X, axis=0)
    stds[stds == 0] = 1
    X_std = (X - means) / stds
    target_mean = float(np.mean(y))
    target_std = float(np.std(y))
    if target_std == 0: target_std = 1
    y_std = (y - target_mean) / target_std

    ridge = Ridge(alpha=alpha, fit_intercept=True)
    ridge.fit(X_std, y_std)
    preds = ridge.predict(X_std) * target_std + target_mean
    r2 = float(r2_score(y, preds))
    mae_val = float(mean_absolute_error(y, preds))
    rmse = float(np.sqrt(np.mean((y - preds) ** 2)))
    n = len(y)

    return {
        'coefficients': [round(float(c), 10) for c in ridge.coef_],
        'intercept': target_mean,
        'featureNames': feature_names,
        'featureMeans': [round(float(m), 10) for m in means],
        'featureStds': [round(float(s), 10) for s in stds],
        'targetMean': target_mean,
        'targetStd': target_std,
        'rSquared': round(r2, 6),
        'adjustedRSquared': round(1 - (1 - r2) * (n - 1) / max(1, n - len(feature_names) - 1), 6),
        'mae': round(mae_val, 4),
        'rmse': round(rmse, 4),
        'n': n,
        'predictions': [round(float(p), 4) for p in preds],
    }


def train_lgb_model(X: np.ndarray, y: np.ndarray, feature_names: list[str],
                     params: dict, n_rounds: int) -> lgb.Booster:
    dt = lgb.Dataset(X, y, feature_name=feature_names, free_raw_data=False)
    return lgb.train({**params, 'verbose': -1}, dt, num_boost_round=n_rounds)


# ── Helpers ─────────────────────────────────────────────────────────

def sf(v):
    if v is None or v == '' or v == 'NA' or v == 'NaN': return 0.0
    try: return float(v)
    except: return 0.0


def load_rows():
    with open(CACHE_PATH) as f:
        data = json.load(f)
    rows = data['rows']
    # Idempotent augmentation — recomputing on already-augmented rows is cheap
    # and gives identical values, so there's no harm if load_rows() is called
    # multiple times per process.
    augment_derived_features(rows)
    return rows


def load_and_persist_augmented_cache():
    """Load the training cache, augment with derived features, save back to disk.

    Run this after changing augment_derived_features() so that TS consumers
    (precompute-features.ts, draft sim, model docs) read the new features from
    the on-disk cache without needing a Python-side augmentation pass.

    Also strips keys listed in DEAD_DERIVED_KEYS from each row — these are
    Python-only derivations that were ablated as dead weight and shouldn't
    be leaking into the on-disk cache.
    """
    print(f'Loading training cache from {CACHE_PATH}...')
    with open(CACHE_PATH) as f:
        data = json.load(f)
    rows = data['rows']
    print(f'  {len(rows)} rows loaded')

    # Strip dead derived keys left over from earlier experiments
    stripped_counts = {k: 0 for k in DEAD_DERIVED_KEYS}
    for r in rows:
        f = r.get('features')
        if not isinstance(f, dict):
            continue
        for k in DEAD_DERIVED_KEYS:
            if k in f:
                del f[k]
                stripped_counts[k] += 1
    total_stripped = sum(stripped_counts.values())
    if total_stripped > 0:
        print(f'  Stripped {total_stripped} dead-key entries:')
        for k, n in stripped_counts.items():
            if n > 0:
                print(f'    {k}: removed from {n} rows')

    print('Augmenting with live derived features...')
    augment_derived_features(rows)

    # Sanity-check: verify the live derived keys are populated
    have_key = {k: any((r.get('features') or {}).get(k, 0) != 0 for r in rows) for k in DERIVED_FEATURE_KEYS}
    print(f'  Live derived-feature coverage:')
    for k, present in have_key.items():
        print(f'    {k}: {"ok" if present else "EMPTY (check logic)"}')

    print(f'Writing augmented cache back to {CACHE_PATH}...')
    with open(CACHE_PATH, 'w') as f:
        json.dump(data, f)
    size_mb = CACHE_PATH.stat().st_size / 1024 / 1024
    print(f'  Wrote {size_mb:.1f} MB')


def make_X(rows, keys):
    return np.array([[sf(r['features'].get(k, 0)) for k in keys] for r in rows])


# ── Derived features ────────────────────────────────────────────────
# Features computed in-memory at training time from the training cache row
# graph. These mirror the TS feature store group in
# src/lib/featureStore/groups/priorMultiYear.ts so Python training and TS
# inference agree on feature values.
#
# Only features that survived ablation + appear in PPG_FEATURE_LISTS are
# computed here — keeping the set minimal avoids drift between the on-disk
# training cache and the TS feature store.
DERIVED_FEATURE_KEYS = [
    'priorPPG2yr',       # QB substitution / RB+WR addition, ablation-positive
    'durabilityStreak',  # TE addition, ablation-positive
]

# Derived-feature keys that were TRIED and ablated as dead weight. Listed
# here so load_and_persist_augmented_cache can strip them from any cache
# that still has them from earlier experiments. Do not re-add without
# running scripts/ablate_ppg_features.py to verify signal.
DEAD_DERIVED_KEYS = [
    'priorPPG3yr',           # correlated with priorPPG2yr, no extra signal
    'ageSquared',            # GBMs handle non-linear age natively
    'yearsInLeagueSquared',  # GBMs handle non-linear experience natively
    'yearsXpriorPPG',        # GBMs learn interactions natively
    'ageDeviationFromPrime', # another non-linear age transform, dead
    'priorAvailabilityRate', # redundant with priorGames (already in models)
    'seasonsPlayedLast5',    # redundant with yearsInLeague
]

# Note: priorQBRating was tested as a derived feature (partial NFL passer
# rating computed from 3 of 4 components available in the training cache)
# but ablation showed it adds no signal to the PPG QB model — existing
# priorPPG2yr / ppgTrend / priorTimeToThrow features already capture QB
# skill. The TS bug fix in priorStats.ts stands on its own as a correctness
# fix; the feature will be populated for future cache rebuilds and is
# available to other models if useful.


def augment_derived_features(rows):
    """Compute derived features in-place on each row's features dict.

    Uses a (name, position, season) -> stats lookup built from the row graph
    itself, so each player's historical seasons inform their current-season
    feature vector without requiring external data.

    Multi-year lookups use rawPPG from PRIOR seasons' rows as the source of
    truth for "did they play and how well?" — this is cleaner than chaining
    priorPPG fields, which would require a season offset.

    Mirrors src/lib/featureStore/groups/priorMultiYear.ts — keep both
    implementations in sync if you change either.
    """
    lookup = {}
    for r in rows:
        name = (r.get('name') or '').lower().strip()
        key = (name, r['position'], r['season'])
        f = r.get('features', {}) or {}
        lookup[key] = {
            'rawPPG': sf(r.get('rawPPG', 0)),
            'priorGames': sf(f.get('priorGames', 0)),
        }

    for r in rows:
        name = (r.get('name') or '').lower().strip()
        pos = r['position']
        season = r['season']
        f = r.setdefault('features', {})
        yil = sf(f.get('yearsInLeague', 0))

        # priorPPG2yr: weighted 2-year prior PPG (0.65 * Y-1 + 0.35 * Y-2)
        y1 = lookup.get((name, pos, season - 1), {}).get('rawPPG', 0.0)
        y2 = lookup.get((name, pos, season - 2), {}).get('rawPPG', 0.0)
        if y1 > 0 and y2 > 0:
            f['priorPPG2yr'] = round(0.65 * y1 + 0.35 * y2, 2)
        elif y1 > 0:
            f['priorPPG2yr'] = round(y1, 2)
        else:
            f['priorPPG2yr'] = 0.0

        # durabilityStreak: consecutive prior seasons with ≥15 games
        streak = 0
        for delta in range(1, int(yil) + 2):
            past_games = lookup.get((name, pos, season - delta), {}).get('priorGames', 0)
            if past_games >= 15:
                streak += 1
            else:
                break
        f['durabilityStreak'] = streak


# ── Feature definitions ─────────────────────────────────────────────

# Load existing caches to get feature names (match exactly)
def load_old_cache(name):
    path = DATA_DIR / name
    if path.exists():
        with open(path) as f:
            return json.load(f)
    return None


# ── ADP Models ──────────────────────────────────────────────────────

ADP_CONFIG = {
    'QB': {'n_est': 80, 'lr': 0.05, 'depth': 2, 'ridge_alpha': 15, 'min_leaf_pct': 0.10},
    'RB': {'n_est': 150, 'lr': 0.06, 'depth': 3, 'ridge_alpha': 8, 'min_leaf_pct': 0.05},
    'WR': {'n_est': 120, 'lr': 0.06, 'depth': 3, 'ridge_alpha': 8, 'min_leaf_pct': 0.06},
    'TE': {'n_est': 60, 'lr': 0.05, 'depth': 2, 'ridge_alpha': 20, 'min_leaf_pct': 0.12},
}

ADP_FEATURES_SET = {'adp', 'adpRound', 'adpTrend', 'adpXage', 'adpXyearsInLeague',
                    'adpXteamPassRate', 'adpXschemeShotgun', 'newArrivalBestADP'}

ROOKIE_FEATURES_MAP = {
    'QB': ['logDraftPick', 'collegeQBR2yr', 'collegeRushYpgPerAge', 'collegeSosFinalYr', 'collegeQbContextScore',
           'vegasImpliedTotal', 'contractAPY'],
    'RB': ['logDraftPick', 'collegeDominatorXLateRound',
           'depthChartRank', 'teamSamePosCount', 'contractAPY'],
    'WR': ['logDraftPick', 'draftPickPct', 'draftPickPctOverall', 'draftClassDepth', 'age',
           'collegeBreakoutScore', 'collegeRecYdsPerTeamPassAtt', 'collegeBestRecYds',
           'weight', 'collegeTeammateScore', 'relativeAthleticScore',
           'depthChartRank', 'teamSamePosCount', 'contractAPY'],
    'TE': ['logDraftPick', 'draftPickPct', 'draftPickPctOverall', 'draftClassDepth', 'age',
           'depthChartRank', 'contractAPY'],
}

PRE_DRAFT_FEATURES_MAP = {
    'QB': ['logDraftPick', 'collegeQBR2yr', 'collegeRushYpgPerAge', 'collegeSosFinalYr', 'collegeQbContextScore'],
    'RB': ['logDraftPick', 'collegeDominatorXLateRound'],
    'WR': ['logDraftPick', 'draftPickPct', 'draftPickPctOverall', 'draftClassDepth', 'age',
           'collegeBreakoutScore', 'collegeRecYdsPerTeamPassAtt', 'collegeBestRecYds',
           'weight', 'collegeTeammateScore', 'relativeAthleticScore'],
    'TE': ['logDraftPick', 'draftPickPct', 'draftPickPctOverall', 'draftClassDepth', 'age'],
}


def train_adp_models(rows):
    """Train ADP models for all positions."""
    old = load_old_cache('model-cache-adp-v56.json')
    if not old:
        print("  No existing ADP cache to get feature names from, skipping")
        return None

    models = []
    for old_m in old['models']:
        pos = old_m['position']
        feature_names = old_m['ridgeModel']['featureNames']
        feature_labels = old_m.get('featureLabels', feature_names)
        cfg = ADP_CONFIG.get(pos, ADP_CONFIG['WR'])

        # Remove leaky features (current-season actual shares that wouldn't be available at prediction time)
        LEAKY_FEATURES = {'actualTargetShare', 'actualRushShare', 'actualReceptionShare',
                          'actualRecYdsShare', 'actualRushYdsShare', 'actualPassTDShare', 'actualRushTDShare'}
        feature_names = [f for f in feature_names if f not in LEAKY_FEATURES]

        pos_rows = [r for r in rows if r['position'] == pos and r.get('adp', 999) <= 250]
        X = make_X(pos_rows, feature_names)
        y = np.array([sf(r.get('rawPPG', 0)) for r in pos_rows])
        seasons = sorted(set(r['season'] for r in pos_rows))
        n = len(pos_rows)

        ra = max(cfg['ridge_alpha'], math.sqrt(len(feature_names)))
        msl = max(3, int(n * cfg['min_leaf_pct']))
        lgb_params = {'objective': 'regression', 'metric': 'mae', 'learning_rate': cfg['lr'],
                      'max_depth': cfg['depth'], 'min_child_samples': msl,
                      'subsample': 0.8, 'colsample_bytree': 0.9, 'seed': 42, 'n_jobs': 1}

        # Full-data models
        ridge = train_ridge_js(X, y, feature_names, ra)
        gbm = train_lgb_model(X, y, feature_names, lgb_params, cfg['n_est'])
        gbm_js = lgb_to_js_gbm(gbm, X, y, feature_names)

        # Quantile models
        gbm_lower = train_lgb_model(X, y, feature_names,
            {**lgb_params, 'objective': 'quantile', 'alpha': 0.10}, cfg['n_est'])
        gbm_upper = train_lgb_model(X, y, feature_names,
            {**lgb_params, 'objective': 'quantile', 'alpha': 0.90}, cfg['n_est'])

        # Rookie sub-models
        rookie_rows = [r for r in pos_rows if (r['features'].get('yearsInLeague', 0) or 0) <= 1]
        vet_rows = [r for r in pos_rows if (r['features'].get('yearsInLeague', 0) or 0) > 1]
        rookie_keys_post = ROOKIE_FEATURES_MAP.get(pos, feature_names)
        rookie_keys_pre = PRE_DRAFT_FEATURES_MAP.get(pos, feature_names)
        yr = np.array([sf(r.get('rawPPG', 0)) for r in rookie_rows])

        rookie_gbm_post = rookie_gbm_pre = rookie_ridge_post = rookie_ridge_pre = None
        rookie_model_type = 'none'
        if len(rookie_rows) >= 50:
            Xr_post = make_X(rookie_rows, rookie_keys_post)
            Xr_pre = make_X(rookie_rows, rookie_keys_pre)
            rookie_ridge_post = train_ridge_js(Xr_post, yr, rookie_keys_post, ra * 3)
            rookie_ridge_pre = train_ridge_js(Xr_pre, yr, rookie_keys_pre, ra * 3)
            rk_params = {**lgb_params, 'min_child_samples': max(5, len(rookie_rows) // 12)}
            gbm_post = train_lgb_model(Xr_post, yr, rookie_keys_post, rk_params, 80)
            gbm_pre = train_lgb_model(Xr_pre, yr, rookie_keys_pre, rk_params, 80)
            rookie_gbm_post = {'models': [lgb_to_js_gbm(gbm_post, Xr_post, yr, rookie_keys_post)]}
            rookie_gbm_pre = {'models': [lgb_to_js_gbm(gbm_pre, Xr_pre, yr, rookie_keys_pre)]}
            rookie_model_type = 'gbm+ridge'
        elif len(rookie_rows) >= 15:
            Xr_post = make_X(rookie_rows, rookie_keys_post)
            Xr_pre = make_X(rookie_rows, rookie_keys_pre)
            rookie_ridge_post = train_ridge_js(Xr_post, yr, rookie_keys_post, ra * 5)
            rookie_ridge_pre = train_ridge_js(Xr_pre, yr, rookie_keys_pre, ra * 5)
            rookie_model_type = 'ridge-only'

        # LOSO CV
        loso_gbm, loso_ridge, loso_ens = [], [], []
        loso_rookie_actuals, loso_rookie_preds = [], []
        loso_vet_actuals, loso_vet_preds = [], []
        loso_predraft_preds, loso_predraft_actuals = [], []
        for held in seasons:
            tr = [i for i, r in enumerate(pos_rows) if r['season'] != held]
            te = [i for i, r in enumerate(pos_rows) if r['season'] == held]
            if len(tr) < 10 or not te: continue
            r_fold = Ridge(alpha=ra); r_fold.fit(X[tr], y[tr]); rp = r_fold.predict(X[te])
            g_fold = train_lgb_model(X[tr], y[tr], feature_names, lgb_params, cfg['n_est'])
            gp = g_fold.predict(X[te])
            ep = gp * 0.7 + rp * 0.3
            for j, idx in enumerate(te):
                loso_gbm.append(gp[j]); loso_ridge.append(rp[j]); loso_ens.append(ep[j])
                is_rookie = (pos_rows[idx]['features'].get('yearsInLeague', 0) or 0) <= 1
                if is_rookie:
                    loso_rookie_actuals.append(y[idx]); loso_rookie_preds.append(ep[j])
                else:
                    loso_vet_actuals.append(y[idx]); loso_vet_preds.append(ep[j])

        cv_r2_gbm = r2_score(y, loso_gbm) if len(loso_gbm) == n else 0
        cv_r2_ridge = r2_score(y, loso_ridge) if len(loso_ridge) == n else 0
        cv_r2_ens = r2_score(y, loso_ens) if len(loso_ens) == n else 0
        cv_mae_gbm = mean_absolute_error(y, loso_gbm) if len(loso_gbm) == n else 0

        model_entry = {
            'position': pos,
            'ridgeModel': ridge,
            'gbmModel': gbm_js,
            'gbmLower': lgb_to_js_gbm(gbm_lower, X, y, feature_names, 'quantile', 0.10),
            'gbmUpper': lgb_to_js_gbm(gbm_upper, X, y, feature_names, 'quantile', 0.90),
            'rookieGbmPostDraft': rookie_gbm_post,
            'rookieGbmPreDraft': rookie_gbm_pre,
            'rookieRidgePostDraft': rookie_ridge_post,
            'rookieRidgePreDraft': rookie_ridge_pre,
            'rookieModelType': rookie_model_type,
            'adpValueAdd': round(float(spearmanr(-np.array(loso_ens), -y)[0] - spearmanr(-np.array([sf(r.get('adp', 999)) for r in pos_rows]), -y)[0]), 3) if len(loso_ens) == n else 0,
            'featureNames': feature_names,
            'featureLabels': feature_labels,
            'n': n,
            'nRookies': len(rookie_rows),
            'nVets': len(vet_rows),
            'hitRate': round(sum(1 for r in pos_rows if r.get('isHit')) / n * 100) if n > 0 else 0,
            'bustRate': round(sum(1 for r in pos_rows if r.get('isBust')) / n * 100) if n > 0 else 0,
            'rSquared': round(float(ridge['rSquared']), 3),
            'mae': round(float(ridge['mae']), 2),
            'cvR2Gbm': round(cv_r2_gbm, 3),
            'cvMaeGbm': round(cv_mae_gbm, 2),
            'cvR2Ridge': round(cv_r2_ridge, 3),
            'cvMaeRidge': round(mean_absolute_error(y, loso_ridge), 2) if len(loso_ridge) == n else 0,
            'cvR2Ensemble': round(cv_r2_ens, 3),
            'cvR2RookieVet': round(cv_r2_ens, 3),
            'cvR2RookieOnly': round(r2_score(loso_rookie_actuals, loso_rookie_preds), 3) if len(loso_rookie_actuals) >= 5 else 0,
            'cvMaeRookieOnly': round(mean_absolute_error(loso_rookie_actuals, loso_rookie_preds), 2) if len(loso_rookie_actuals) >= 5 else 0,
            'cvR2PreDraftRookie': 0,
            'cvMaePreDraftRookie': 0,
            'cvR2VetOnly': round(r2_score(loso_vet_actuals, loso_vet_preds), 3) if len(loso_vet_actuals) >= 5 else 0,
            'cvMaeVetOnly': round(mean_absolute_error(loso_vet_actuals, loso_vet_preds), 2) if len(loso_vet_actuals) >= 5 else 0,
            'cvR2GbmBaseline': round(cv_r2_gbm, 3),
        }
        models.append(model_entry)
        print(f"    {pos}: n={n}, Ens R²={cv_r2_ens:.3f}, MAE={cv_mae_gbm:.2f}")

    # Preserve feature importance and other top-level fields from old cache
    result = {
        'models': models,
        'featureImportance': old.get('featureImportance', {}),
        'rookieFeatureImportance': old.get('rookieFeatureImportance', {}),
        'rookiePreDraftFeatureImportance': old.get('rookiePreDraftFeatureImportance', {}),
        'vetFeatureImportance': old.get('vetFeatureImportance', {}),
        'draftSim2025': old.get('draftSim2025', {}),
        'posThresholds': old.get('posThresholds', {}),
    }
    return result


# ── PPG Models ──────────────────────────────────────────────────────

def train_ppg_models(rows):
    """Train ADP-free PPG models.

    Feature lists below are the pruned sets produced by running
    scripts/ablate_ppg_features.py on the post-leakage-fix + feature-additions
    feature sets, then picking the best strategy per position:
      QB: drop NOISE only (Δ ≥ -0.001)      → 23 → 19 features, +0.0081 R²
      RB: top-20 by ablation Δ              → 41 → 20 features, +0.0075 R²
      WR: top-21 by ablation Δ              → 43 → 21 features, +0.0063 R²
      TE: keep only Δ > 0 features          → 25 → 13 features, +0.0162 R²

    Notable inclusions: priorWOPR for RB (Δ=+0.0050, the only valuable
    addition from the injury/advanced/QB-context batch).

    Re-run ablation + re-pick via scripts/ablate_ppg_features.py if you
    add or change features. DO NOT hand-edit these lists without rerunning
    the measurement.
    """
    old = load_old_cache('model-cache-ppg-v56.json')
    if not old:
        print("  No existing PPG cache, skipping")
        return None

    # Feature lists pruned via scripts/ablate_ppg_features.py, then augmented
    # with derived features chosen by substitution testing (per position):
    #
    #   QB: priorPPG → priorPPG2yr (substitution)   +0.0064 R²
    #   RB: +priorPPG2yr            (addition)      +0.0022 R²
    #   WR: +priorPPG2yr            (addition)      +0.0011 R²
    #   TE: +durabilityStreak       (addition)      +0.0013 R²
    #
    # Tried and rejected (ablation negative or dead): ageSquared, yearsInLeagueSquared,
    # yearsXpriorPPG, ageDeviationFromPrime, priorPPG3yr, priorAvailabilityRate,
    # seasonsPlayedLast5. GBMs capture the non-linear age / interaction signal
    # natively; no Ridge-style transforms help.
    #
    # IMPORTANT: priorPPG2yr and durabilityStreak are computed in Python via
    # augment_derived_features() when load_rows() is called, but they are NOT
    # yet populated in the TS feature store. The TS inference path (draft sim,
    # 2026 predictions) will see these features as 0 until they're ported.
    # Follow-up PR needed: port augment_derived_features to a TS feature group.
    PPG_FEATURE_LISTS = {
        'QB': [
            'yearsInLeague', 'nflDraftPick', 'invDraftPick', 'draftPickPctOverall',
            'priorTimeToThrow', 'priorPPG2yr',  # was priorPPG (single year)
            'teamSamePosCount', 'newArrivalBestPPR',
            'teamNeutralPassRate', 'teamShotgunRate', 'vegasImpliedSpread', 'vegasWinPct',
            'collegeQBR', 'collegeSosFinalYr', 'ppgTrend', 'teamRosterTurnover',
            'priorInjuryWeeks', 'injuryRecurrence', 'priorKneeInjury',
        ],
        'RB': [
            'age', 'yearsInLeague', 'invDraftPick', 'draftClassDepth', 'vertical', 'bmi',
            'priorRecEPA', 'priorRushEPA', 'priorPPR', 'teamSamePosCount',
            'teammatePriorPPR', 'projPlayerPPR', 'projTargetShare', 'prospectGrade',
            'ppgTrend', 'priorBoomRate', 'qbOwnRushYds',
            'priorWOPR', 'priorAirYardsShare', 'teamQBPassRating',
            'priorPPG2yr',
            # Forward-selection additions: combine athleticism + broader draft-capital
            # encoding + schedule context. RB was stuck at 0.504 for two PRs; this
            # combo unlocks +0.006 R² (0.504 → 0.510).
            'forty', 'nflDraftRound', 'sosAvgSpread',
            # Post-backfill addition: 3+WR sets signal — RB usage drops in spread
            # formations. Populated by scripts/backfill_team_features.py using
            # pbp_participation offense_personnel. +0.0025 R² → 0.5125.
            'teamWR3PlusOnField',
        ],
        'WR': [
            'age', 'nflDraftRound', 'nflDraftPick', 'logDraftPick', 'invDraftPick',
            'draftPickPct', 'draftPickPctOverall', 'broadJump', 'vertical',
            'priorTargetShare', 'priorYACAboveExp', 'priorPPG', 'priorGames',
            'newArrivalBestPPR', 'priorPPGXage', 'qbOwnPPG',
            'priorBoomRate', 'priorBustGameRate', 'teamDomeGames',
            'priorInjuryWeeks', 'injuryRecurrence',
            'priorPPG2yr',
            # Forward-selection: team WR corps production (inverse = WR opportunity)
            'teamWRTotalPPR',
        ],
        'TE': [
            'age', 'nflDraftRound', 'nflDraftPick', 'invDraftPick', 'draftClassDepth',
            'weight', 'bench', 'priorYACperRec', 'priorPPG', 'priorGames',
            'heightAdjSpeedScore', 'priorBoomRate',
            'priorAirYardsShare',
            'durabilityStreak',
            # Forward-selection: a second draft-pick encoding helps separate tiers
            'draftPickPct',
            # Post-backfill: 21-personnel (2 RB, 1 TE) rate. Surprisingly helps TE —
            # likely because 21-heavy teams tend to feature their single TE in key
            # looks rather than spread targets across multiple TEs. +0.0025 R².
            'team21Rate',
            # Post-player-backfill: weeks 1-2 injury report designations (proxy
            # for "entered the season banged up"). +0.0027 R² for TE — aging
            # TEs carrying injuries into Week 1 visibly underperform. Only
            # useful position from the preseason-injury backfill.
            'preseasonInjWeeks',
        ],
    }

    # Per-position hyperparameters from scripts/sweep_ppg_hyperparams.py.
    # TE is baseline-optimal (sweep found no improvement). Don't hand-edit
    # without re-running the sweep — fine-tuning these is noise-sensitive.
    PPG_CONFIG = {
        'QB': {'depth': 3, 'lr': 0.08, 'n_rounds': 100, 'min_leaf': 8,  'gbm_weight': 0.9},  # +0.0075
        'RB': {'depth': 3, 'lr': 0.08, 'n_rounds': 200, 'min_leaf': 25, 'gbm_weight': 0.7},  # +0.0044
        'WR': {'depth': 3, 'lr': 0.12, 'n_rounds': 200, 'min_leaf': 3,  'gbm_weight': 0.7},  # +0.0117
        'TE': {'depth': 3, 'lr': 0.05, 'n_rounds': 100, 'min_leaf': 8,  'gbm_weight': 0.7},  # baseline optimal
    }

    ppg_models = []
    for old_m in old['ppgModels']:
        pos = old_m['position']
        feature_names = list(PPG_FEATURE_LISTS[pos])
        cfg = PPG_CONFIG[pos]
        old_feats = old_m['ridgeModel']['featureNames']
        print(f"    {pos}: {len(feature_names)} features "
              f"(pruned from {len(old_feats)}, "
              f"+{len([f for f in feature_names if f not in old_feats])} new, "
              f"-{len([f for f in old_feats if f not in feature_names])} dropped); "
              f"lr={cfg['lr']} n={cfg['n_rounds']} mcs={cfg['min_leaf']} gbmW={cfg['gbm_weight']}")
        pos_rows = [r for r in rows if r['position'] == pos and r.get('adp', 999) <= 250]
        X = make_X(pos_rows, feature_names)
        y = np.array([sf(r.get('rawPPG', 0)) for r in pos_rows])
        n = len(pos_rows)

        ridge = train_ridge_js(X, y, feature_names, 15)
        lgb_params = {
            'objective': 'regression', 'metric': 'mae',
            'learning_rate': cfg['lr'], 'max_depth': cfg['depth'],
            'min_child_samples': cfg['min_leaf'], 'subsample': 0.8,
            'seed': 42, 'n_jobs': 1,
        }
        gbm = train_lgb_model(X, y, feature_names, lgb_params, cfg['n_rounds'])
        gbm_js = lgb_to_js_gbm(gbm, X, y, feature_names)

        # LOSO
        seasons = sorted(set(r['season'] for r in pos_rows))
        loso = np.zeros(n)
        for held in seasons:
            tr = [i for i, r in enumerate(pos_rows) if r['season'] != held]
            te = [i for i, r in enumerate(pos_rows) if r['season'] == held]
            if len(tr) < 10 or not te: continue
            r_fold = Ridge(alpha=15); r_fold.fit(X[tr], y[tr]); rp = r_fold.predict(X[te])
            g_fold = train_lgb_model(X[tr], y[tr], feature_names, lgb_params, cfg['n_rounds'])
            gp = g_fold.predict(X[te])
            gbm_w = cfg['gbm_weight']
            for j, idx in enumerate(te): loso[idx] = gp[j] * gbm_w + rp[j] * (1 - gbm_w)

        cv_r2 = r2_score(y, loso)
        # Feature labels: preserve old labels for kept features, keep order consistent with feature_names
        old_names = old_m['ridgeModel']['featureNames']
        old_labels = old_m.get('featureLabels', old_names)
        label_map = dict(zip(old_names, old_labels))
        feature_labels = [label_map.get(f, f) for f in feature_names]
        ppg_models.append({
            'position': pos,
            'gbmModel': gbm_js,
            'ridgeModel': ridge,
            'featureNames': feature_names,
            'featureLabels': feature_labels,
            'n': n,
            'cvR2Gbm': round(cv_r2, 3),
            'cvR2Ridge': round(r2_score(y, Ridge(alpha=15).fit(X, y).predict(X)), 3),
            'cvMaeGbm': round(mean_absolute_error(y, loso), 2),
            'adpValueAdd': old_m.get('adpValueAdd', 0),
        })
        print(f"    {pos}: n={n}, R²={cv_r2:.3f}")

    return {'ppgModels': ppg_models}


# ── Share Models ────────────────────────────────────────────────────

SHARE_FEATURE_KEYS = [
    'priorTeamTargetShare', 'priorTeamTouchShare', 'priorTargetShare',
    'priorSnapPct', 'depthChartRank', 'teamSamePosCount',
    'contractAPY', 'age', 'yearsInLeague', 'priorPPG',
    'nflDraftPick', 'priorReceptions', 'priorTargets', 'priorCarries',
    'teamTargetHHI', 'vegasImpliedTotal',
    # V2 additions: +0.049 avg R² across all 15 share models
    'adp', 'teamElitePassCatchers', 'priorWOPR',
]

SHARE_TARGETS = [
    ('actualTargetShare', 'predTargetShare', ['RB', 'WR', 'TE']),
    ('actualRushShare', 'predRushShare', ['RB']),
    ('actualReceptionShare', 'predReceptionShare', ['RB', 'WR', 'TE']),
    ('actualRecYdsShare', 'predRecYdsShare', ['RB', 'WR', 'TE']),
    ('actualRushYdsShare', 'predRushYdsShare', ['RB']),
    ('actualPassTDShare', 'predPassTDShare', ['RB', 'WR', 'TE']),
    ('actualRushTDShare', 'predRushTDShare', ['RB']),
]


def train_share_models(rows):
    """Train share prediction models."""
    share_models = {}
    for actual_key, pred_key, positions in SHARE_TARGETS:
        for pos in positions:
            pos_rows = [r for r in rows if r['position'] == pos
                        and sf(r['features'].get(actual_key, 0)) > 0
                        and sf(r['features'].get('priorPPG', 0)) > 0]
            if len(pos_rows) < 20:
                continue

            X = make_X(pos_rows, SHARE_FEATURE_KEYS)
            y = np.array([sf(r['features'].get(actual_key, 0)) for r in pos_rows])
            n = len(pos_rows)
            seasons = sorted(set(r['season'] for r in pos_rows))

            depth = 3 if pos == 'RB' else 2
            blend_r = 0.4 if pos == 'RB' else 0.5

            lgb_params = {'objective': 'regression', 'metric': 'mae', 'learning_rate': 0.04,
                          'max_depth': depth, 'min_child_samples': max(3, int(n * 0.08)),
                          'subsample': 0.8, 'colsample_bytree': 0.9, 'seed': 42, 'n_jobs': 1,
                          'bagging_fraction': 0.8, 'bagging_freq': 1}

            # LOSO
            loso = np.zeros(n)
            for held in seasons:
                tr = [i for i, r in enumerate(pos_rows) if r['season'] != held]
                te = [i for i, r in enumerate(pos_rows) if r['season'] == held]
                if len(tr) < 15 or not te: continue
                r_fold = Ridge(alpha=5); r_fold.fit(X[tr], y[tr]); rp = r_fold.predict(X[te])
                g_fold = train_lgb_model(X[tr], y[tr], SHARE_FEATURE_KEYS, lgb_params, 60)
                gp = g_fold.predict(X[te])
                for j, idx in enumerate(te):
                    loso[idx] = np.clip(rp[j] * blend_r + gp[j] * (1 - blend_r), 0, 1)

            valid = loso != 0
            cv_r2 = r2_score(y[valid], loso[valid]) if valid.sum() >= 10 else 0
            cv_mae = mean_absolute_error(y[valid], loso[valid]) if valid.sum() >= 10 else 0

            # Full-data models
            ridge = train_ridge_js(X, y, SHARE_FEATURE_KEYS, 5)
            gbm = train_lgb_model(X, y, SHARE_FEATURE_KEYS, lgb_params, 60)
            gbm_js = lgb_to_js_gbm(gbm, X, y, SHARE_FEATURE_KEYS)

            model_key = f'{pos}_{pred_key}'
            share_models[model_key] = {
                'ridgeModel': ridge,
                'gbmModel': gbm_js,
                'featureKeys': SHARE_FEATURE_KEYS,
                'cvR2': round(cv_r2, 3),
                'cvMAE': round(cv_mae, 3),
                'n': n,
            }
            print(f"    {model_key:30s} n={n:4d} R²={cv_r2:.3f}")

    return {'shareModels': share_models}


# ── Residual Models ─────────────────────────────────────────────────

def train_residual_models(rows):
    """Train ADP-residual models."""
    old = load_old_cache('model-cache-residual-v56.json')
    if not old:
        print("  No existing residual cache, skipping")
        return None

    residual_models = []
    for old_m in old['residualModels']:
        pos = old_m['position']
        feature_names = old_m['ridgeModel']['featureNames']
        pos_rows = [r for r in rows if r['position'] == pos and r.get('adp', 999) <= 250]
        X = make_X(pos_rows, feature_names)
        y_ppg = np.array([sf(r.get('rawPPG', 0)) for r in pos_rows])
        adps = np.array([sf(r.get('adp', 999)) for r in pos_rows])
        n = len(pos_rows)

        # ADP→PPG curve
        valid_adp = adps < 250
        if valid_adp.sum() >= 10:
            coeffs = np.polyfit(adps[valid_adp], y_ppg[valid_adp], 1)
            adp_slope, adp_intercept = float(coeffs[0]), float(coeffs[1])
        else:
            adp_slope, adp_intercept = old_m.get('adpSlope', 0), old_m.get('adpIntercept', 0)

        y_residual = y_ppg - (adp_intercept + adp_slope * adps)

        ridge = train_ridge_js(X, y_residual, feature_names, 8)
        lgb_params = {'objective': 'regression', 'metric': 'mae', 'learning_rate': 0.05,
                      'max_depth': 3, 'min_child_samples': 8, 'subsample': 0.8, 'seed': 42, 'n_jobs': 1}
        gbm = train_lgb_model(X, y_residual, feature_names, lgb_params, 100)
        gbm_js = lgb_to_js_gbm(gbm, X, y_residual, feature_names)

        residual_models.append({
            'position': pos,
            'gbmModel': gbm_js,
            'ridgeModel': ridge,
            'adpSlope': adp_slope,
            'adpIntercept': adp_intercept,
            'bestAlpha': old_m.get('bestAlpha', 1),
            'featureNames': feature_names,
            'n': n,
            'backtest': old_m.get('backtest', {}),
            'playersDraftSim': old_m.get('playersDraftSim', {}),
            'lastSeason': old_m.get('lastSeason', {}),
        })
        print(f"    {pos}: n={n}")

    return {'residualModels': residual_models}


# ── Main ────────────────────────────────────────────────────────────

def main():
    args = set(sys.argv[1:])
    only = None
    if '--only' in args:
        idx = sys.argv.index('--only')
        if idx + 1 < len(sys.argv):
            only = set(sys.argv[idx + 1].split(','))

    rows = load_rows()
    print(f'Loaded {len(rows)} training rows')
    t0 = time.time()

    if only is None or 'adp' in only:
        print('\n  Training ADP models...')
        adp = train_adp_models(rows)
        if adp:
            with open(DATA_DIR / 'model-cache-adp-v56.json', 'w') as f:
                json.dump(adp, f)
            print(f'  ADP cache saved.')

    if only is None or 'ppg' in only:
        print('\n  Training PPG models...')
        ppg = train_ppg_models(rows)
        if ppg:
            with open(DATA_DIR / 'model-cache-ppg-v56.json', 'w') as f:
                json.dump(ppg, f)
            print(f'  PPG cache saved.')

    if only is None or 'share' in only:
        print('\n  Training Share models...')
        share = train_share_models(rows)
        if share:
            with open(DATA_DIR / 'model-cache-share-v56.json', 'w') as f:
                json.dump(share, f)
            print(f'  Share cache saved.')

    if only is None or 'residual' in only:
        print('\n  Training Residual models...')
        residual = train_residual_models(rows)
        if residual:
            with open(DATA_DIR / 'model-cache-residual-v56.json', 'w') as f:
                json.dump(residual, f)
            print(f'  Residual cache saved.')

    elapsed = time.time() - t0
    print(f'\nDone in {elapsed:.1f}s')


if __name__ == '__main__':
    main()
