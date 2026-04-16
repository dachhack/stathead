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
CACHE_PATH = DATA_DIR / 'training-rows-cache-v48.json'


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
    """Convert trained LightGBM to JS-compatible GBM format.

    CRITICAL: LightGBM's dump_model() returns leaf_values that ALREADY include
    shrinkage (learning_rate) AND the boost_from_average initial offset.
    Empirically verified: LGB.predict(x) == sum(leaf_value across all trees).

    The JS predictor at src/lib/gbm.ts computes:
        pred = initialPrediction + learningRate * sum(leaf_value)

    To match LGB.predict() exactly, we emit initialPrediction=0 and
    learningRate=1 so the JS formula collapses to sum(leaf_value). Do NOT
    emit mean(y) and the original lr — that double-shrinks every prediction
    and collapses the model to a near-constant around mean(y).

    This was the bug fixed after the original Python training PR (#723d21e)
    shipped for 10+ subsequent PRs with CV R² computed against lgb.predict()
    (correct) but production TS predictions applying the shrinkage twice.
    See the guard test in scripts/tests/test_lgb_js_equivalence.py.
    """
    dump = model.dump_model()
    trees = [_convert_node(t['tree_structure']) for t in dump['tree_info']]
    preds = model.predict(X)
    r2 = float(r2_score(y, preds))
    mae_val = float(mean_absolute_error(y, preds))
    rmse = float(np.sqrt(np.mean((y - preds) ** 2)))
    n = len(y)
    return {
        'trees': trees,
        'initialPrediction': 0.0,  # baked into leaf_values by LightGBM
        'learningRate': 1.0,       # baked into leaf_values by LightGBM
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


def _scale_leaf_values(node: dict, factor: float) -> None:
    """Recursively multiply every leaf's value by `factor` in-place."""
    if node.get('featureIndex', -1) == -1:
        node['value'] = round(node['value'] * factor, 10)
        return
    if node.get('left'):
        _scale_leaf_values(node['left'], factor)
    if node.get('right'):
        _scale_leaf_values(node['right'], factor)


def train_bagged_lgb(X: np.ndarray, y: np.ndarray, feature_names: list[str],
                      lgb_params: dict, n_rounds: int, n_bags: int) -> list[lgb.Booster]:
    """Train N LightGBM boosters on bootstrap resamples for bagging.

    Classical bootstrap aggregating (Breiman 1996):
      - For each bag, sample n rows with replacement from (X, y). The
        resulting sample contains ~63% of unique rows; ~37% of rows appear
        zero times, and ~25% appear twice or more.
      - Train a full LightGBM booster on this bootstrap sample with the
        SAME hyperparameters as a single-model fit — same optimal split
        strategy, same depth, same n_rounds. Each bag fits optimally to
        its own slightly-different view of the data.
      - Different seeds also drive LightGBM's internal row/feature
        subsampling (if the caller set bagging_freq>0) so bags further
        diverge iteration-to-iteration.

    Bagging only helps high-variance learners. For low-variance ensembles
    (shallow trees, many rounds, regularized params — our PPG config),
    bootstrap sampling can actually regress because it reduces effective
    training data per bag without enough variance reduction to compensate.
    A hyperparameter re-sweep jointly with bagging is usually needed to
    unlock lift; see the PPG bagging null-result discussion in the commit
    history for details. Career models (n<200 per position, deeper trees)
    do benefit from this approach, which is why it's the established
    project recipe from train_career_models.py.
    """
    n = X.shape[0]
    boosters = []
    base_seed = int(lgb_params.get('seed', 42))
    for bag_idx in range(n_bags):
        rng = np.random.default_rng(base_seed + bag_idx)
        idx = rng.integers(0, n, size=n)  # sample with replacement
        Xb = X[idx]
        yb = y[idx]
        p = dict(lgb_params)
        p['seed'] = base_seed + bag_idx
        p['bagging_seed'] = base_seed + bag_idx
        p['feature_fraction_seed'] = base_seed + bag_idx
        boosters.append(train_lgb_model(Xb, yb, feature_names, p, n_rounds))
    return boosters


def bagged_predict(boosters: list[lgb.Booster], X: np.ndarray) -> np.ndarray:
    """Mean prediction across all bagged boosters. This is the target the
    JS-side emission must match."""
    return np.mean(np.stack([b.predict(X) for b in boosters], axis=0), axis=0)


def bagged_lgb_to_js_bag(boosters: list[lgb.Booster], X: np.ndarray, y: np.ndarray,
                          feature_names: list[str], loss: str = 'squared') -> dict:
    """Convert a bagged LGB ensemble to the JS `BaggedGBM` interface shape.

    Output schema matches src/lib/gbm.ts::BaggedGBM:
        { models: TrainedGBM[] }   — an array of per-bag GBMs, each in the
                                      standard init=0 / lr=1 flat-trees format

    Used by train_career_models.py so career predictions can route through
    src/lib/rookieCareerModel.ts::predictRookieCareerPPG, which calls
    predictBaggedGBM(cm.gbmModel, features) and averages per-bag predictions.
    Unlike bagged_lgb_to_js_gbm (which concatenates trees + scales leaves for
    zero-TS-change consumers of predictGBM), this helper preserves per-bag
    models so downstream code can access individual bag predictions for
    uncertainty bands if needed.
    """
    if len(boosters) < 1:
        raise ValueError("bagged_lgb_to_js_bag requires at least one booster")
    models = [lgb_to_js_gbm(b, X, y, feature_names, loss=loss) for b in boosters]
    return {'models': models, 'nBags': len(boosters)}


def bagged_lgb_to_js_gbm(boosters: list[lgb.Booster], X: np.ndarray, y: np.ndarray,
                          feature_names: list[str], loss: str = 'squared',
                          quantile: float | None = None) -> dict:
    """Convert a bagged LightGBM ensemble to a single JS-compatible GBM dict.

    Bagging math for squared-loss regression:
        bagged(x) = (1/N) * Σ_k LGB_k.predict(x)
                  = (1/N) * Σ_k Σ leaf_value(x; bag_k)
                  = Σ_all_trees_across_bags (leaf_value / N)

    Strategy: concatenate every tree from every bag into one flat tree list,
    divide every leaf_value by N at emission time. The TS predictor then
    computes `0 + 1 * Σ leaf_value` (per the PR-1 invariant) which exactly
    reproduces the bagged prediction — zero TS-side changes required.

    Advantage over an explicit per-bag array format:
      - TS inference unchanged (no new predict function or schema bump)
      - Feature importance aggregation is automatic (one flat model)
      - Identical JSON shape between single-model and bagged-model caches

    Tradeoff:
      - Lossy: per-bag disagreement (useful for prediction intervals) is
        collapsed. If we later want bag-level uncertainty, we can switch
        to an explicit array format in a follow-up PR.
      - Only valid for identity-link squared loss / unmodified quantile
        loss. For classification (sigmoid output) this math does NOT hold.
        PPG / ADP / residual / share are all squared regression, so fine.
    """
    n_bags = len(boosters)
    if n_bags < 1:
        raise ValueError("bagged_lgb_to_js_gbm requires at least one booster")

    # Concatenate every tree from every bag, scale leaves by 1/N_BAGS.
    all_trees = []
    for b in boosters:
        dump = b.dump_model()
        for t in dump['tree_info']:
            tree = _convert_node(t['tree_structure'])
            _scale_leaf_values(tree, 1.0 / n_bags)
            all_trees.append(tree)

    # Bagged predictions for the emitted metrics
    preds = bagged_predict(boosters, X)
    r2 = float(r2_score(y, preds))
    mae_val = float(mean_absolute_error(y, preds))
    rmse = float(np.sqrt(np.mean((y - preds) ** 2)))
    n = len(y)
    return {
        'trees': all_trees,
        'initialPrediction': 0.0,  # invariant: PR 1 fix, bagged math collapses to this
        'learningRate': 1.0,       # invariant: leaves already scaled by 1/N_BAGS
        'featureNames': feature_names,
        'rSquared': round(r2, 6),
        'adjustedRSquared': round(1 - (1 - r2) * (n - 1) / max(1, n - len(feature_names) - 1), 6),
        'mae': round(mae_val, 4),
        'rmse': round(rmse, 4),
        'n': n,
        'predictions': [round(float(p), 4) for p in preds],
        'loss': loss,
        'nBags': n_bags,  # informational; TS predictor ignores this field
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
            'yearsInLeague', 'invDraftPick', 'draftPickPctOverall',
            # Dropped by ablation re-pass (post-PR-1 at correct hyperparams):
            #   nflDraftPick          Δ=-0.0015  (noise at the measured single-drop
            #                                     level; signal carried by invDraftPick
            #                                     and draftPickPctOverall).
            # Tried-and-reverted: draftPickPctOverall (Δ=+0.0008) and priorKneeInjury
            # (Δ=+0.0001) were borderline at one-at-a-time ablation, but dropping
            # all three together regressed QB by 0.003 (mutual-signal effect).
            # Kept in — marginal positive ≥0 always, pays their keep.
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
            'ppgTrend', 'priorBoomRate',
            # Dropped by ablation re-pass (Δ=-0.0030, clear noise):
            #   qbOwnRushYds — correlated with invDraftPick / teamQBPassRating,
            #   adds noise. Dropping improves R² by 0.003.
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
            'age', 'nflDraftRound', 'invDraftPick',
            # Dropped by ablation re-pass:
            #   nflDraftPick  Δ=-0.0002   (redundant with invDraftPick + nflDraftRound)
            #   logDraftPick  Δ=-0.0000   (redundant — 5 other draft-pick encodings)
            'draftPickPct', 'draftPickPctOverall', 'broadJump', 'vertical',
            'priorTargetShare', 'priorYACAboveExp', 'priorPPG', 'priorGames',
            'newArrivalBestPPR', 'priorPPGXage', 'qbOwnPPG',
            'priorBoomRate', 'priorBustGameRate', 'teamDomeGames',
            'priorInjuryWeeks', 'injuryRecurrence',
            'priorPPG2yr',
            # Forward-selection: team WR corps production (inverse = WR opportunity)
            'teamWRTotalPPR',
            # Non-leaky late-prior-season injury signal (weeks 15-18 of S-1).
            # Captures WRs who ended last year hurt and entered the new
            # season with lingering issues. +0.0011 R² for WR.
            'priorLateSeasonInjWeeks',
        ],
        'TE': [
            'age', 'nflDraftRound', 'nflDraftPick', 'draftClassDepth',
            # Dropped by ablation re-pass:
            #   invDraftPick  Δ=-0.0005  (redundant with nflDraftPick + nflDraftRound
            #                             + draftPickPct at TE's small feature count)
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
            # Non-leaky late-prior-season injury signal (weeks 15-18 of S-1).
            # Replaces the leaky preseasonInjWeeks shipped in #120 which
            # used weeks 1-2 of CURRENT season (outcome leakage).
            # +0.0036 R² for TE — stronger than the leaky version actually.
            'priorLateSeasonInjWeeks',
        ],
    }

    # Per-position hyperparameters from scripts/sweep_ppg_hyperparams.py.
    # Re-swept after the PR 1 export bug fix and the PPG re-ablation pass
    # at the correct per-position baselines. QB and WR were already at the
    # local optimum (sweep found no improvement); RB dropped n_rounds 200→150
    # (was slightly overfit, 25% faster and +0.0005 R²) and bumped gbm_weight
    # 0.7→0.8; TE bumped n_rounds 100→150 (+0.0008 R²). Don't hand-edit
    # without re-running the sweep — fine-tuning these is noise-sensitive.
    #
    # Sync any changes with PPG_BASELINE_CONFIG in sweep_ppg_hyperparams.py.
    PPG_CONFIG = {
        'QB': {'depth': 3, 'lr': 0.08, 'n_rounds': 100, 'min_leaf': 8,  'gbm_weight': 0.9},  # local opt
        'RB': {'depth': 3, 'lr': 0.08, 'n_rounds': 150, 'min_leaf': 25, 'gbm_weight': 0.8},  # re-swept +0.0005
        'WR': {'depth': 3, 'lr': 0.12, 'n_rounds': 200, 'min_leaf': 3,  'gbm_weight': 0.7},  # local opt
        'TE': {'depth': 3, 'lr': 0.05, 'n_rounds': 150, 'min_leaf': 8,  'gbm_weight': 0.7},  # re-swept +0.0008
    }

    # Bagging count per position. Each bag is a full booster trained on a
    # bootstrap resample. Emitted as a single concatenated tree list with
    # leaf values scaled by 1/N_BAGS so the TS predictor (init=0, lr=1)
    # reproduces the bagged mean exactly (see bagged_lgb_to_js_gbm).
    #
    # CURRENT SETTING: all 1s (bagging disabled for PPG, single-model path).
    #
    # Empirical result: bagging was tested at N ∈ {3, 5, 10} both with and
    # without n_rounds inflation (1.0x, 1.3x, 1.6x) to compensate for the
    # ~63%-unique bootstrap sample. Every configuration regressed PPG LOSO
    # R² by 0.003–0.016 vs the single-model baseline:
    #
    #   QB (n=595)  1 bag: 0.614  |  10 bags: 0.607 (-0.007)
    #   RB (n=1270) 1 bag: 0.512  |  10 bags: 0.509 (-0.003)
    #   WR (n=1731) 1 bag: 0.570  |  10 bags: 0.565 (-0.005)
    #   TE (n=732)  1 bag: 0.627  |  10 bags: 0.616 (-0.011)
    #
    # Root cause: PPG models use shallow trees (depth=3) with many rounds
    # (100–200) and tuned regularization, so they're already low-variance
    # learners. Bootstrap resampling reduces effective per-bag training
    # data without enough variance reduction to compensate. The existing
    # single-model hyperparameters are at the bias-variance sweet spot for
    # this feature count and sample size.
    #
    # Follow-up options (not scoped here):
    #   1. Joint bagging + hyperparameter re-sweep — deeper trees and/or
    #      more rounds per bag might give bagging room to help.
    #   2. Feature-bagging ("random GBM forest") — per-bag feature subsets
    #      instead of row subsets. Also needs a sweep.
    #   3. Apply to residual models instead — smaller per-position n and
    #      lower baseline signal might be a better fit for bagging.
    #
    # The infrastructure (train_bagged_lgb, bagged_lgb_to_js_gbm, the guard
    # test case in test_lgb_js_equivalence.py) is kept in place so any of
    # those follow-ups is a one-line change. Bagging is known to help the
    # career models (train_career_models.py:237 uses the same recipe).
    BAG_CONFIG = {'QB': 1, 'RB': 1, 'WR': 1, 'TE': 1}

    ppg_models = []
    for old_m in old['ppgModels']:
        pos = old_m['position']
        feature_names = list(PPG_FEATURE_LISTS[pos])
        cfg = PPG_CONFIG[pos]
        n_bags = BAG_CONFIG[pos]
        old_feats = old_m['ridgeModel']['featureNames']
        print(f"    {pos}: {len(feature_names)} features "
              f"(pruned from {len(old_feats)}, "
              f"+{len([f for f in feature_names if f not in old_feats])} new, "
              f"-{len([f for f in old_feats if f not in feature_names])} dropped); "
              f"lr={cfg['lr']} n={cfg['n_rounds']} mcs={cfg['min_leaf']} "
              f"gbmW={cfg['gbm_weight']} bags={n_bags}")
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
        if n_bags > 1:
            boosters = train_bagged_lgb(X, y, feature_names, lgb_params, cfg['n_rounds'], n_bags)
            gbm_js = bagged_lgb_to_js_gbm(boosters, X, y, feature_names)
        else:
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
            if n_bags > 1:
                fold_boosters = train_bagged_lgb(X[tr], y[tr], feature_names,
                                                  lgb_params, cfg['n_rounds'], n_bags)
                gp = bagged_predict(fold_boosters, X[te])
            else:
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
    """Train ADP-residual models.

    Residual target: y_residual = rawPPG - (adp_intercept + adp_slope * adp).
    The model learns corrections on top of a linear ADP→PPG baseline.

    Feature lists below are the pruned sets produced by running
    scripts/ablate_residual_features.py on the post-leakage-fix feature set.
    The pre-pruning lists were inherited from an old training cache and were
    full of dead weight (combine measurables, redundant draft encodings,
    rookie-only features applied to veterans). Kept only features with
    ablation Δ ≥ 0 — positive-or-neutral marginal contribution.

    Previous lengths: QB 20, RB 34, WR 37, TE 16 (107 total features)
    Post-ablation:    QB  8, RB 18, WR 13, TE  8 ( 47 total features)  −56%

    Re-run scripts/ablate_residual_features.py if you add or change features.
    DO NOT hand-edit these lists without rerunning the measurement.
    """
    old = load_old_cache('model-cache-residual-v56.json')
    if not old:
        print("  No existing residual cache, skipping")
        return None

    # Hand-curated residual feature lists, pruned to only features with
    # ablation Δ ≥ 0 (positive or neutral marginal contribution on the
    # residual-ensemble LOSO R²). See scripts/ablate_residual_features.py
    # for the measurement methodology and public/data/residual-feature-ablation.json
    # for the raw Δ values.
    RESIDUAL_FEATURE_LISTS = {
        'QB': [
            # Δ ≥ 0.001 (useful / important)
            'ppgTrend', 'byeWeek', 'priorPPG', 'yearsInLeague',
            'priorSnapPct', 'projPlayerPPR',
            # Borderline (Δ ∈ (-0.001, 0.001)). Going aggressive (only the 6
            # keepers) regressed QB LOSO by 0.003 — the 7 borderlines are
            # mutual-signal reservoirs the GBM needs at n=595 small sample.
            # Back off and keep all 7 borderlines.
            'collegeQBR', 'teamNeutralPassRate', 'invDraftPick',
            'draftClassDepth', 'teamSamePosCount', 'nflDraftPick',
            'newArrivalBestPPR',
        ],
        'RB': [
            # Δ ≥ 0.001 (14 features)
            'priorCarries', 'logDraftPick', 'yearsInLeague', 'priorPPG',
            'teamRBElitePPR', 'byeWeek', 'priorPPGXage', 'depthChartRank',
            'projPlayerVsExpected', 'invDraftPick', 'speedScore',
            'draftClassDepth', 'broadJump', 'age',
            # Positive borderline (Δ ∈ [0, 0.001))
            'priorPPGStdDev', 'shuttle', 'nflDraftPick', 'draftPickPctOverall',
        ],
        'WR': [
            # Δ ≥ 0.001 (only 4 "useful" features — WR residual signal is weak)
            'yearsInLeague', 'teammatePriorPPR', 'draftClassDepth', 'teamPassCatcherPPR',
            # Positive borderline (Δ ∈ [0, 0.001)). Kept to give the GBM enough
            # feature diversity to avoid degenerate fits at depth=3 × 100 rounds.
            'age', 'vertical', 'prospectGrade', 'invDraftPick', 'projPlayerPPR',
            'priorAirYardsPerTarget', 'speedScore', 'nflDraftPick', 'sosDefPassYdg',
        ],
        'TE': [
            # Δ ≥ 0.001 (useful / important)
            'weight', 'priorGames', 'shuttle', 'teamWRTotalPPR',
            'invDraftPick', 'nflDraftRound',
            # Positive borderline
            'nflDraftPick', 'priorPPG',
        ],
    }

    # Per-position residual hyperparameters from an inline sweep (see
    # public/data/residual-hyperparam-sweep.json). The pre-sweep config was a
    # hardcoded universal {depth=3, lr=0.05, n=100, mcs=8, gbm_w=0.7} —
    # never tuned per position. The sweep found that QB and RB both want
    # deeper trees (depth=5) with low lr (0.03) and higher GBM weight, while
    # TE prefers shallow + fast (depth=2, lr=0.12). WR stayed at the old
    # universal baseline.
    #
    # Don't hand-edit without re-running the sweep — these interact heavily
    # with the RESIDUAL_FEATURE_LISTS above (smaller feature sets want
    # different hyperparams).
    RESIDUAL_CONFIG = {
        'QB': {'depth': 5, 'lr': 0.03, 'n_rounds': 100, 'min_leaf': 15, 'gbm_weight': 0.9},  # +0.0122
        'RB': {'depth': 5, 'lr': 0.03, 'n_rounds': 100, 'min_leaf': 25, 'gbm_weight': 0.8},  # +0.0235
        'WR': {'depth': 3, 'lr': 0.05, 'n_rounds': 100, 'min_leaf': 8,  'gbm_weight': 0.8},  # +0.0008
        'TE': {'depth': 2, 'lr': 0.12, 'n_rounds': 100, 'min_leaf': 8,  'gbm_weight': 0.8},  # +0.0035
    }

    # Per-position bag counts. FIRST successful bagging result in this
    # session — PPG was structurally allergic, but residual at the newly-
    # tuned depth=5 / depth=3 configs has room for variance reduction.
    # Empirical diagnostic at N ∈ {1, 3, 5, 10}:
    #     QB (n=595):  all bagging N regressed (-0.002 to -0.007 ens R²)
    #     RB (n=1270): N=5 gained +0.0042; N=10 gained +0.0019
    #     WR (n=1731): N=5 gained +0.0033; N=10 gained +0.0018
    #     TE (n=732):  all bagging N regressed (-0.008 to -0.017 ens R²)
    # Pattern: bagging helped the larger-n positions (RB, WR) and hurt the
    # smaller ones. With depth=5 trees, small-n bootstrap samples end up
    # with too few rows per leaf to generalize well. N=5 was the sweet spot
    # where bagging helped without over-reducing effective training data.
    RESIDUAL_BAG_CONFIG = {'QB': 1, 'RB': 5, 'WR': 5, 'TE': 1}

    residual_models = []
    for old_m in old['residualModels']:
        pos = old_m['position']
        feature_names = RESIDUAL_FEATURE_LISTS[pos]
        cfg = RESIDUAL_CONFIG[pos]
        n_bags = RESIDUAL_BAG_CONFIG[pos]
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
        lgb_params = {
            'objective': 'regression', 'metric': 'mae',
            'learning_rate': cfg['lr'], 'max_depth': cfg['depth'],
            'min_child_samples': cfg['min_leaf'], 'subsample': 0.8,
            'seed': 42, 'n_jobs': 1,
        }
        if n_bags > 1:
            boosters = train_bagged_lgb(X, y_residual, feature_names, lgb_params, cfg['n_rounds'], n_bags)
            gbm_js = bagged_lgb_to_js_gbm(boosters, X, y_residual, feature_names)
        else:
            gbm = train_lgb_model(X, y_residual, feature_names, lgb_params, cfg['n_rounds'])
            gbm_js = lgb_to_js_gbm(gbm, X, y_residual, feature_names)

        # LOSO CV — hold out one season at a time. Gives an honest R² for
        # the residual fit independent of the ADP curve. Previously there
        # was no CV here, which hid the leakage behind in-sample metrics.
        seasons = sorted(set(r['season'] for r in pos_rows))
        loso_gbm = np.zeros(n)
        loso_ridge = np.zeros(n)
        for held in seasons:
            tr = [i for i, r in enumerate(pos_rows) if r['season'] != held]
            te = [i for i, r in enumerate(pos_rows) if r['season'] == held]
            if len(tr) < 15 or not te:
                continue
            # Recompute residual target inside the fold using the fold's own
            # ADP curve so the CV is honest end-to-end.
            adps_tr = adps[tr]
            y_ppg_tr = y_ppg[tr]
            valid_tr = adps_tr < 250
            if valid_tr.sum() >= 10:
                c = np.polyfit(adps_tr[valid_tr], y_ppg_tr[valid_tr], 1)
                s_tr, i_tr = float(c[0]), float(c[1])
            else:
                s_tr, i_tr = adp_slope, adp_intercept
            y_res_tr = y_ppg_tr - (i_tr + s_tr * adps_tr)
            y_res_te_true = y_ppg[te] - (i_tr + s_tr * adps[te])

            r_fold = Ridge(alpha=8)
            r_fold.fit(X[tr], y_res_tr)
            rp = r_fold.predict(X[te])
            if n_bags > 1:
                bb_fold = train_bagged_lgb(X[tr], y_res_tr, feature_names,
                                            lgb_params, cfg['n_rounds'], n_bags)
                gp = bagged_predict(bb_fold, X[te])
            else:
                g_fold = train_lgb_model(X[tr], y_res_tr, feature_names, lgb_params, cfg['n_rounds'])
                gp = g_fold.predict(X[te])
            for j, idx in enumerate(te):
                loso_gbm[idx] = gp[j]
                loso_ridge[idx] = rp[j]

        # Compare honest residual predictions against honest per-fold targets.
        # y_residual (above) is global-fit; for CV metrics we recompute per-fold.
        y_residual_loso = np.zeros(n)
        for held in seasons:
            tr = [i for i, r in enumerate(pos_rows) if r['season'] != held]
            te = [i for i, r in enumerate(pos_rows) if r['season'] == held]
            if len(tr) < 15 or not te:
                continue
            adps_tr = adps[tr]
            y_ppg_tr = y_ppg[tr]
            valid_tr = adps_tr < 250
            if valid_tr.sum() >= 10:
                c = np.polyfit(adps_tr[valid_tr], y_ppg_tr[valid_tr], 1)
                s_tr, i_tr = float(c[0]), float(c[1])
            else:
                s_tr, i_tr = adp_slope, adp_intercept
            for idx in te:
                y_residual_loso[idx] = y_ppg[idx] - (i_tr + s_tr * adps[idx])

        cv_r2_gbm = float(r2_score(y_residual_loso, loso_gbm)) if n > 0 else 0.0
        cv_r2_ridge = float(r2_score(y_residual_loso, loso_ridge)) if n > 0 else 0.0
        cv_mae_gbm = float(mean_absolute_error(y_residual_loso, loso_gbm)) if n > 0 else 0.0
        # Ensemble LOSO R² at the per-position gbm_weight — this is the
        # number the sweep optimizes and the closest proxy to shipped
        # blended-PPG quality.
        gbm_w = cfg['gbm_weight']
        loso_ens = gbm_w * loso_gbm + (1 - gbm_w) * loso_ridge
        cv_r2_ens = float(r2_score(y_residual_loso, loso_ens)) if n > 0 else 0.0

        residual_models.append({
            'position': pos,
            'gbmModel': gbm_js,
            'ridgeModel': ridge,
            'adpSlope': adp_slope,
            'adpIntercept': adp_intercept,
            'bestAlpha': old_m.get('bestAlpha', 1),
            'featureNames': feature_names,
            'n': n,
            'cvR2Gbm': round(cv_r2_gbm, 3),
            'cvR2Ridge': round(cv_r2_ridge, 3),
            'cvR2Ensemble': round(cv_r2_ens, 3),
            'cvMaeGbm': round(cv_mae_gbm, 2),
            'gbmWeight': gbm_w,
            'backtest': old_m.get('backtest', {}),
            'playersDraftSim': old_m.get('playersDraftSim', {}),
            'lastSeason': old_m.get('lastSeason', {}),
        })
        print(f"    {pos}: n={n}, features={len(feature_names)}, "
              f"cvR2Gbm={cv_r2_gbm:.3f}, cvR2Ridge={cv_r2_ridge:.3f}, "
              f"cvR2Ens={cv_r2_ens:.3f}")

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
