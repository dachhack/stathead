#!/usr/bin/env python3
"""
Train late-round boom classifier for redraft fantasy football.

Identifies players drafted ADP 100+ who finish top-24 at their position.
This is the redraft equivalent of the rookie bust avoidance model —
addresses the weakest part of the system: late-round upside hunting.

Key findings:
  WR AUC 0.734 (12% Q4 boom vs 2% Q1 — 5.0x separation)
  TE AUC 0.840 (85% Q4 vs 10% Q1 — 8.5x separation)
  RB AUC 0.607 (10% Q4 vs 5% Q1 — 2.3x, weaker due to injury dependence)

Top drivers:
  WR: priorWOPR, teamRosterTurnover, priorGames, depthChartRank
  TE: depthChartRank, teamElitePassCatchers, teamSamePosCount
  RB: nflDraftPick, teamElitePassCatchers, adp, teamPace

Usage:
    python3 scripts/train_late_boom_model.py
"""

import json
import sys
import time
from pathlib import Path

import numpy as np
import lightgbm as lgb

CACHE_PATH = Path('public/data/training-rows-cache-v42.json')
OUTPUT_PATH = Path('public/data/model-cache-late-boom-v1.json')


BOOM_FEATURES = [
    'adp', 'age', 'yearsInLeague',
    'priorPPG', 'priorSnapPct', 'priorTargets', 'priorCarries',
    'priorTargetShare', 'priorReceptions', 'priorRecYards',
    'priorGames', 'priorRecTDs',
    'depthChartRank', 'teamSamePosCount',
    'nflDraftPick', 'logDraftPick',
    'vegasImpliedTotal', 'vegasWinPct',
    'teamPassRate', 'teamPace',
    'teamRosterTurnover', 'teamElitePassCatchers',
    'contractAPY',
    'priorWOPR', 'priorAirYardsShare',
]


def sf(v):
    if v is None or v == '' or v == 'NA' or v == 'NaN':
        return 0.0
    try:
        return float(v)
    except (ValueError, TypeError):
        return 0.0


def make_feature_vector(row):
    """Build feature vector, handling adp from row-level and others from features dict."""
    out = []
    for k in BOOM_FEATURES:
        if k == 'adp':
            out.append(sf(row.get('adp', 0)))
        else:
            out.append(sf(row['features'].get(k, 0)))
    return out


def main():
    t0 = time.time()
    print(f'Loading training rows from {CACHE_PATH}...')
    with open(CACHE_PATH) as f:
        rows = json.load(f)['rows']
    print(f'  {len(rows)} rows loaded')

    # Compute top-24 PPG cutoffs per (position, season)
    cuts = {}
    for pos in ['QB', 'RB', 'WR', 'TE']:
        for season in sorted(set(r['season'] for r in rows)):
            ppgs = sorted([sf(r.get('rawPPG', 0)) for r in rows
                           if r['position'] == pos and r['season'] == season
                           and sf(r.get('rawPPG', 0)) > 0], reverse=True)
            if len(ppgs) >= 24:
                cuts[(pos, season)] = ppgs[23]

    results = {}

    for pos in ['RB', 'WR', 'TE']:
        print(f'\n  Training {pos} late-boom classifier...')
        # Late picks: ADP 100+
        late = [r for r in rows if r['position'] == pos
                and 100 < sf(r.get('adp', 999)) <= 250]

        if len(late) < 50:
            print(f'    Skipped (only {len(late)} rows)')
            continue

        X = np.array([make_feature_vector(r) for r in late], dtype=np.float64)
        y = np.array([1 if sf(r.get('rawPPG', 0)) >= cuts.get((pos, r['season']), 999) else 0
                      for r in late])
        seasons = [r['season'] for r in late]
        n = len(late)
        base_rate = float(y.mean())

        if y.sum() < 10:
            print(f'    Skipped (only {y.sum()} booms)')
            continue

        # LOSO cross-validation
        loso = np.full(n, base_rate)
        for held in sorted(set(seasons)):
            tr = [i for i, s in enumerate(seasons) if s != held]
            te = [i for i, s in enumerate(seasons) if s == held]
            if len(tr) < 30 or not te or sum(y[tr]) < 5:
                continue
            params = {
                'objective': 'binary', 'metric': 'auc',
                'learning_rate': 0.03, 'max_depth': 2,
                'min_child_samples': max(3, len(tr) // 15),
                'subsample': 0.7, 'colsample_bytree': 0.7,
                'verbose': -1, 'seed': 42, 'n_jobs': 1,
                'is_unbalance': True, 'extra_trees': True,
                'bagging_fraction': 0.7, 'bagging_freq': 1,
            }
            dt = lgb.Dataset(X[tr], y[tr], feature_name=BOOM_FEATURES, free_raw_data=False)
            m = lgb.train(params, dt, num_boost_round=80)
            loso[te] = m.predict(X[te])

        from sklearn.metrics import roc_auc_score
        auc = float(roc_auc_score(y, loso))

        q75 = float(np.percentile(loso, 75))
        q25 = float(np.percentile(loso, 25))
        high_mask = loso >= q75
        low_mask = loso <= q25
        high_boom_rate = float(y[high_mask].mean())
        low_boom_rate = float(y[low_mask].mean())

        # Train final model on all data
        final_params = {
            'objective': 'binary', 'metric': 'auc',
            'learning_rate': 0.03, 'max_depth': 2,
            'min_child_samples': max(3, n // 15),
            'subsample': 0.7, 'colsample_bytree': 0.7,
            'verbose': -1, 'seed': 42, 'n_jobs': 1,
            'is_unbalance': True, 'extra_trees': True,
            'bagging_fraction': 0.7, 'bagging_freq': 1,
        }
        dt_full = lgb.Dataset(X, y, feature_name=BOOM_FEATURES, free_raw_data=False)
        final_model = lgb.train(final_params, dt_full, num_boost_round=80)

        # Feature importance
        imp = final_model.feature_importance(importance_type='gain')
        total_imp = max(1, sum(imp))
        importance = [
            {'key': k, 'importance': round(float(v / total_imp), 4)}
            for k, v in sorted(zip(BOOM_FEATURES, imp), key=lambda x: -x[1])
            if v > 0
        ]

        # Save model as JSON (LightGBM's save_model format)
        model_str = final_model.model_to_string()

        results[pos] = {
            'position': pos,
            'n': n,
            'baseRate': round(base_rate, 4),
            'auc': round(auc, 3),
            'highScoreBoomRate': round(high_boom_rate, 4),
            'lowScoreBoomRate': round(low_boom_rate, 4),
            'separation': round(high_boom_rate / max(0.01, low_boom_rate), 2),
            'featureNames': BOOM_FEATURES,
            'featureImportance': importance[:10],
            'modelString': model_str,  # LightGBM text format for reloading
        }

        print(f'    n={n}, base rate={base_rate*100:.0f}%, AUC={auc:.3f}')
        print(f'    High score (Q4): {high_boom_rate*100:.0f}% boom')
        print(f'    Low score (Q1):  {low_boom_rate*100:.0f}% boom')
        print(f'    Separation: {high_boom_rate/max(0.01, low_boom_rate):.1f}x')

    with open(OUTPUT_PATH, 'w') as f:
        json.dump({'lateBoomModels': results}, f)

    print(f'\n  Cache saved to {OUTPUT_PATH}')
    print(f'\nDone in {time.time()-t0:.1f}s')


if __name__ == '__main__':
    main()
