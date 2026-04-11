#!/usr/bin/env python3
"""Train KTC dynasty-value-change models.

Replaces the in-browser training at src/components/KTCPredictiveModel.tsx
with a Python pipeline matching the PPG/ADP/Share/Residual/Career path.

Target: valueDeltaPct = (lateValue - earlyValue) / earlyValue * 100
where earlyValue ≈ Oct 14 KTC value and lateValue ≈ Dec 31 KTC value.

DATA CONSTRAINTS (critical context for interpretation):

1. KTC's public history endpoint returns a rolling 6-month window only.
   Earliest date in the current snapshot is 2025-10-14. There is NO 2024
   data, no earlier seasons. The TSX hardcodes TRAIN_SEASONS=[2024, 2025]
   but 2024 adds zero rows — the model has been silently training on one
   season's worth of data.

2. "earlyValue" in the TSX is named septValue but actually resolves to
   mid-October via a 45-day fallback in getValueNearMonth. Sept 15 target
   lands on Oct 14 for every player because that's the earliest record.
   The effective window is Oct 14 → Dec 31 (~11 weeks), not Sept → Dec.

3. Cross-season LOSO is impossible with only one season of data. We use
   5-fold random player CV per position instead. Within-team feature
   correlation is a minor leakage risk but is negligible at this sample
   size (42-118 rows per position); team-holdout would leave 1-2 test
   rows per QB fold, too few to measure.

4. ~420 KTC players have valid early+late values, but only ~295 have a
   matching 2025 row in training-rows-cache-v42.json. The remaining 125
   are players who didn't meet the ADP ≤ 250 filter the training cache
   pipeline uses. Expanding to the full 420 requires porting the TSX's
   inline feature-assembly logic, which is out of scope for this first
   pass — noted as a follow-up.

The output cache (model-cache-ktc-v1.json) ships in the same
{ktcModels: [{position, ridgeModel, gbmModel, ...}, ...]} shape the
other model caches use, consumed by src/components/KTCPredictiveModel.tsx
at inference time (the in-browser training block gets deleted in a
follow-up PR).

Usage:
    python3 scripts/train_ktc_models.py
"""

import json
import re
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import lightgbm as lgb
from sklearn.linear_model import Ridge
from sklearn.metrics import r2_score, mean_absolute_error
from sklearn.model_selection import KFold

sys.path.insert(0, str(Path(__file__).parent))
from train_projection_models import (  # noqa: E402
    lgb_to_js_gbm, train_lgb_model, train_ridge_js, sf,
)

DATA_DIR = Path('public/data')
KTC_RANKINGS = DATA_DIR / 'ktc_rankings_1qb.json'
KTC_HISTORY = DATA_DIR / 'ktc_history.json'
TRAINING_CACHE = DATA_DIR / 'training-rows-cache-v42.json'
OUTPUT_CACHE = DATA_DIR / 'model-cache-ktc-v1.json'

# Hardcoded training seasons (matches TSX). Currently only 2025 has
# matching KTC history; 2024 adds zero rows because KTC doesn't return
# that far back. Left as a list so the shape is future-proof — if KTC
# ever exposes longer history we can expand without code changes.
TRAIN_SEASONS = [2025]

N_FOLDS = 5  # player-level random CV (team-LOSO is too noisy at n=42-118)


# ── Feature lists ────────────────────────────────────────────────────
#
# Lifted from src/components/KTCPredictiveModel.tsx:69-184 with renames
# for training-cache compatibility. See the audit in the commit message
# for the original TSX name → training cache name mapping:
#
#   septValue          → earlyValue       (computed from KTC history; target input)
#   draftRound         → nflDraftRound    (alt name in training cache)
#   draftPick          → nflDraftPick     (alt name in training cache)
#   priorFantasyPPR    → priorPPR         (alt name in training cache)
#   priorDepthChartRank→  (dropped — not in training cache)
#   depthChartChange   →  (dropped — not in training cache)
#   teamWins           →  (dropped — not in training cache)
#   teamPPG            →  (dropped — not in training cache)
#   priorCompletions   →  (dropped — not in training cache, QB only)
#   priorAttempts      →  (dropped — not in training cache, QB only)

COMMON_FEATURES = [
    'earlyValue',  # KTC-specific, computed from history
    'age', 'nflDraftRound', 'nflDraftPick', 'yearsInLeague',
    'weight', 'bmi', 'forty', 'speedScore',
    'depthChartRank',
    'priorGames', 'priorPPR', 'priorPPG', 'priorSnapPct',
    'priorInjuryWeeks', 'priorGamesOut', 'priorGamesMissed',
    # Projection model features (from src/lib/playerProjection.ts)
    'projTeamPassAtt', 'projTeamPassVolChg', 'projPlayerPPR',
    'projPlayerVsExpected', 'projTargetShare',
]
QB_EXTRAS = [
    'priorPassYards', 'priorPassTDs', 'priorINTs',
    'priorRushYards', 'priorRushTDs',
]
RB_EXTRAS = [
    'priorRushYards', 'priorRushTDs', 'priorYPC', 'priorTargets',
    'priorReceptions', 'priorRecYards', 'priorTotalTouches',
]
WR_EXTRAS = [
    'priorTargets', 'priorReceptions', 'priorRecYards', 'priorRecTDs',
    'priorRushYards',
]
TE_EXTRAS = [
    'priorTargets', 'priorReceptions', 'priorRecYards', 'priorRecTDs',
]

POS_EXTRAS = {'QB': QB_EXTRAS, 'RB': RB_EXTRAS, 'WR': WR_EXTRAS, 'TE': TE_EXTRAS}


def feature_list_for(pos: str) -> list[str]:
    return COMMON_FEATURES + POS_EXTRAS[pos]


# ── Hyperparameters ───────────────────────────────────────────────────
# Ported from KTCPredictiveModel.tsx:530-536 (the TSX GBM config).
# Per-position sweep comes in a follow-up commit — these are baseline
# values matching the existing in-browser model.
KTC_CONFIG = {
    'QB': {'depth': 3, 'lr': 0.10, 'n_rounds': 100, 'min_leaf_pct': 0.05, 'gbm_weight': 0.7},
    'RB': {'depth': 3, 'lr': 0.10, 'n_rounds': 100, 'min_leaf_pct': 0.05, 'gbm_weight': 0.7},
    'WR': {'depth': 3, 'lr': 0.10, 'n_rounds': 100, 'min_leaf_pct': 0.05, 'gbm_weight': 0.7},
    'TE': {'depth': 3, 'lr': 0.10, 'n_rounds': 100, 'min_leaf_pct': 0.05, 'gbm_weight': 0.7},
}
RIDGE_ALPHA = 5  # matches TSX default `lambda`


# ── Name normalization ───────────────────────────────────────────────
# Port of KTCPredictiveModel.tsx:155 normalizeName(), with an added
# trailing-suffix strip (jr, sr, ii, iii, iv, v) so KTC's "Marvin
# Harrison Jr." matches the training cache's "Marvin Harrison".

def normalize_name(name: str) -> str:
    if not name:
        return ''
    n = name.lower()
    n = re.sub(r'[^a-z ]', '', n)
    n = re.sub(r'\s+', ' ', n).strip()
    n = re.sub(r'\s+(jr|sr|ii|iii|iv|v)$', '', n)
    return n.strip()


# ── KTC history sampling ─────────────────────────────────────────────
# Port of KTCPredictiveModel.tsx:160 getValueNearMonth().
# Finds the KTC value nearest the middle of the target month, with a
# 45-day tolerance. If no record exists within 45 days, returns None.

def get_value_near_month(vh: list[dict], year: int, month: int) -> float | None:
    prefix = f'{year}-{month:02d}'
    in_month = [h for h in vh if h['d'].startswith(prefix)]
    if in_month:
        return float(in_month[-1]['v'])
    target = datetime(year, month, 15)
    closest = None
    min_diff = timedelta.max
    for h in vh:
        try:
            d = datetime.strptime(h['d'], '%Y-%m-%d')
        except (ValueError, KeyError):
            continue
        diff = abs(d - target)
        if diff < min_diff:
            min_diff = diff
            closest = h
    return float(closest['v']) if closest and min_diff < timedelta(days=45) else None


# ── Data assembly ─────────────────────────────────────────────────────

def build_rows(rankings: list[dict], history_by_id: dict, cache_rows_by_key: dict) -> list[dict]:
    """Join KTC rankings × history × training-cache to produce model rows.

    For each (KTC player, training season) pair:
      1. Compute earlyValue (Sept 15 ± 45d) and lateValue (Dec 15 ± 45d)
         from the player's KTC value history.
      2. Skip if either value is missing or earlyValue is zero (can't
         compute percent change).
      3. Look up the matching training-cache row by (normalized_name,
         season, position) to get the feature vector.
      4. Skip if no matching training cache row.

    The returned row dict has: name, team, position, season, playerID,
    earlyValue, lateValue, valueDeltaPct (target), features (dict).
    """
    out = []
    missing_in_cache = 0
    for p in rankings:
        pos = p.get('position')
        if pos not in POS_EXTRAS:
            continue
        h = history_by_id.get(p.get('playerID'))
        if not h:
            continue
        vh = h.get('oneQB', {}).get('valueHistory', [])
        for season in TRAIN_SEASONS:
            early_val = get_value_near_month(vh, season, 9)
            late_val = get_value_near_month(vh, season, 12)
            if early_val is None or late_val is None or early_val <= 0:
                continue
            key = (normalize_name(p['playerName']), season, pos)
            cache_row = cache_rows_by_key.get(key)
            if cache_row is None:
                missing_in_cache += 1
                continue
            # Merge cache features with KTC-specific earlyValue
            feats = dict(cache_row.get('features') or {})
            feats['earlyValue'] = early_val
            out.append({
                'name': p['playerName'],
                'team': p.get('team', ''),
                'position': pos,
                'season': season,
                'playerID': p['playerID'],
                'earlyValue': early_val,
                'lateValue': late_val,
                'valueDeltaPct': (late_val - early_val) / early_val * 100.0,
                'features': feats,
            })
    if missing_in_cache:
        print(f'  (skipped {missing_in_cache} KTC players with no matching training-cache row — '
              f'mostly ADP > 250 or injured/retired)')
    return out


def make_X(rows: list[dict], keys: list[str]) -> np.ndarray:
    return np.array([[sf(r['features'].get(k, 0)) for k in keys] for r in rows])


# ── Training ──────────────────────────────────────────────────────────

def train_position(rows: list[dict], pos: str) -> dict | None:
    pos_rows = [r for r in rows if r['position'] == pos]
    if len(pos_rows) < 15:
        print(f'  {pos}: only {len(pos_rows)} rows — too few to train (need ≥15), skipping')
        return None

    cfg = KTC_CONFIG[pos]
    feature_names = feature_list_for(pos)
    X = make_X(pos_rows, feature_names)
    y = np.array([r['valueDeltaPct'] for r in pos_rows])
    n = len(pos_rows)
    min_leaf = max(3, int(n * cfg['min_leaf_pct']))

    lgb_params = {
        'objective': 'regression', 'metric': 'mae',
        'learning_rate': cfg['lr'], 'max_depth': cfg['depth'],
        'min_child_samples': min_leaf, 'subsample': 0.8,
        'seed': 42, 'n_jobs': 1,
    }

    # Full-data models (these are the ones that ship)
    ridge = train_ridge_js(X, y, feature_names, RIDGE_ALPHA)
    gbm = train_lgb_model(X, y, feature_names, lgb_params, cfg['n_rounds'])
    gbm_js = lgb_to_js_gbm(gbm, X, y, feature_names)

    # 5-fold random CV for honest out-of-sample R²
    loso_gbm = np.zeros(n)
    loso_ridge = np.zeros(n)
    kf = KFold(n_splits=N_FOLDS, shuffle=True, random_state=42)
    for fold_i, (tr, te) in enumerate(kf.split(np.arange(n))):
        if len(tr) < 10:
            continue
        r_fold = Ridge(alpha=RIDGE_ALPHA)
        r_fold.fit(X[tr], y[tr])
        loso_ridge[te] = r_fold.predict(X[te])
        g_fold = train_lgb_model(X[tr], y[tr], feature_names, lgb_params, cfg['n_rounds'])
        loso_gbm[te] = g_fold.predict(X[te])

    gbm_w = cfg['gbm_weight']
    loso_ens = gbm_w * loso_gbm + (1 - gbm_w) * loso_ridge

    cv_r2_gbm = float(r2_score(y, loso_gbm))
    cv_r2_ridge = float(r2_score(y, loso_ridge))
    cv_r2_ens = float(r2_score(y, loso_ens))
    cv_mae_gbm = float(mean_absolute_error(y, loso_gbm))

    # Also compute in-sample (matches what TSX reports on the dynasty tab)
    in_sample_gbm = gbm.predict(X)
    in_sample_ridge = np.array(ridge['predictions'])
    in_sample_r2_gbm = float(r2_score(y, in_sample_gbm))

    return {
        'position': pos,
        'ridgeModel': ridge,
        'gbmModel': gbm_js,
        'featureNames': feature_names,
        'n': n,
        'cvR2Gbm': round(cv_r2_gbm, 3),
        'cvR2Ridge': round(cv_r2_ridge, 3),
        'cvR2Ensemble': round(cv_r2_ens, 3),
        'cvMaeGbm': round(cv_mae_gbm, 2),
        'inSampleR2Gbm': round(in_sample_r2_gbm, 3),
        'gbmWeight': gbm_w,
        'meanDeltaPct': round(float(np.mean(y)), 2),
        'stdDeltaPct': round(float(np.std(y)), 2),
    }


def main():
    t0 = time.time()
    print(f'Loading KTC rankings from {KTC_RANKINGS}...')
    with open(KTC_RANKINGS) as f:
        rankings = json.load(f)
    print(f'  {len(rankings)} players')

    print(f'Loading KTC history from {KTC_HISTORY}...')
    with open(KTC_HISTORY) as f:
        history = json.load(f)
    history_by_id = {h['playerID']: h for h in history}
    print(f'  {len(history)} players with value history')

    print(f'Loading training cache from {TRAINING_CACHE}...')
    with open(TRAINING_CACHE) as f:
        cache = json.load(f)
    cache_rows_by_key = {}
    for r in cache['rows']:
        key = (normalize_name(r.get('name', '')), r.get('season'), r.get('position'))
        cache_rows_by_key[key] = r
    print(f'  {len(cache["rows"])} total rows, '
          f'{sum(1 for r in cache["rows"] if r.get("season") in TRAIN_SEASONS)} in TRAIN_SEASONS')

    print('\nBuilding KTC training rows...')
    rows = build_rows(rankings, history_by_id, cache_rows_by_key)
    print(f'  {len(rows)} rows built')
    from collections import Counter
    pos_counts = Counter(r['position'] for r in rows)
    for pos in ['QB', 'RB', 'WR', 'TE']:
        print(f'    {pos}: {pos_counts.get(pos, 0)}')

    print('\nTraining KTC models...')
    models = []
    for pos in ['QB', 'RB', 'WR', 'TE']:
        m = train_position(rows, pos)
        if m is None:
            continue
        models.append(m)
        print(f'  {pos}: n={m["n"]}, '
              f'cvR2Gbm={m["cvR2Gbm"]:.3f}, cvR2Ridge={m["cvR2Ridge"]:.3f}, '
              f'cvR2Ens={m["cvR2Ensemble"]:.3f}, '
              f'in-sample GBM R²={m["inSampleR2Gbm"]:.3f} '
              f'(TSX-comparable)')

    output = {
        'ktcModels': models,
        'meta': {
            'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%S'),
            'trainSeasons': TRAIN_SEASONS,
            'nFolds': N_FOLDS,
            'note': (
                'KTC API exposes 6-month rolling history only; TRAIN_SEASONS=[2025] '
                'is what the current snapshot supports. See scripts/train_ktc_models.py '
                'header for context.'
            ),
        },
    }
    with open(OUTPUT_CACHE, 'w') as f:
        json.dump(output, f)
    print(f'\nKTC cache saved to {OUTPUT_CACHE} ({OUTPUT_CACHE.stat().st_size / 1024:.0f} KB)')
    print(f'Done in {time.time() - t0:.1f}s')


if __name__ == '__main__':
    main()
