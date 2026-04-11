#!/usr/bin/env python3
"""
Train late-round boom classifier for redraft fantasy football.

Uses POSITIONAL RANKS instead of raw ADP to identify late-round upside.
This matches actual draft strategy — dynasty drafters think in positional
tiers, not global ADP. Thresholds scale with position scarcity.

Late-pick definition (drafted at or beyond this positional ADP rank):
  QB: QB12+   (after QB1-11 off the board)
  RB: RB24+   (after RB1-23 off the board)
  WR: WR36+   (after WR1-35 off the board)
  TE: TE10+   (after TE1-9 off the board)

Boom definition (finishes at or above this positional PPG rank):
  QB: top 5   (weekly QB1 / high-end starter)
  RB: top 12  (RB1 for redraft)
  WR: top 18  (WR2 / flex-worthy starter)
  TE: top 5   (elite TE1)

This is the redraft equivalent of the rookie bust avoidance model —
addresses the weakest part of the system: late-round upside hunting.

Usage:
    python3 scripts/train_late_boom_model.py
"""

import json
import sys
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
import lightgbm as lgb
from sklearn.metrics import roc_auc_score

CACHE_PATH = Path('public/data/training-rows-cache-v42.json')
OUTPUT_PATH = Path('public/data/model-cache-late-boom-v1.json')


# Per-position thresholds.
#   lateRank: minimum positional ADP rank to be considered a "late pick"
#   boomRank: maximum positional PPG rank to qualify as a "boom"
POS_THRESHOLDS = {
    'QB': {'lateRank': 12, 'boomRank': 5},
    'RB': {'lateRank': 24, 'boomRank': 12},
    'WR': {'lateRank': 36, 'boomRank': 18},
    'TE': {'lateRank': 10, 'boomRank': 5},
}

# Sanity cap on raw ADP — excludes rows where ADP is just a placeholder.
MAX_ADP = 300.0


BOOM_FEATURES = [
    'adpPosRank',  # NEW: within-position ADP rank (1-indexed)
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


def compute_positional_ranks(rows):
    """Attach adpPosRank and ppgPosRank to each row, grouped by (pos, season).

    - adpPosRank: 1-indexed rank among players with a valid ADP at same pos/season.
      Rows without a valid ADP get adpPosRank = None (skipped downstream).
    - ppgPosRank: 1-indexed rank by rawPPG descending across ALL players at pos/season.
      Players who didn't play (PPG 0) land at the bottom and never count as booms.
    """
    groups = defaultdict(list)
    for r in rows:
        groups[(r['position'], r['season'])].append(r)

    for _, group in groups.items():
        # ADP rank — only among players with a plausible ADP
        valid_adp = [r for r in group if 0 < sf(r.get('adp', 0)) <= MAX_ADP]
        valid_adp.sort(key=lambda r: sf(r.get('adp', 0)))
        for rank, r in enumerate(valid_adp, start=1):
            r['adpPosRank'] = rank

        # PPG rank — rank everyone, ties broken by original order (stable sort)
        by_ppg = sorted(group, key=lambda r: -sf(r.get('rawPPG', 0)))
        for rank, r in enumerate(by_ppg, start=1):
            r['ppgPosRank'] = rank


def make_feature_vector(row):
    """Build feature vector. adp/adpPosRank come from the row; rest from features dict."""
    out = []
    for k in BOOM_FEATURES:
        if k == 'adp':
            out.append(sf(row.get('adp', 0)))
        elif k == 'adpPosRank':
            # Use the positional rank we attached in compute_positional_ranks.
            # Missing rank (should not happen for filtered rows) defaults to a large value.
            out.append(float(row.get('adpPosRank') or 999))
        else:
            out.append(sf(row['features'].get(k, 0)))
    return out


def train_position(rows, pos):
    thresh = POS_THRESHOLDS[pos]
    late_rank = thresh['lateRank']
    boom_rank = thresh['boomRank']

    late = [
        r for r in rows
        if r['position'] == pos
        and r.get('adpPosRank') is not None
        and r['adpPosRank'] >= late_rank
        and sf(r.get('adp', 0)) <= MAX_ADP
    ]

    if len(late) < 50:
        print(f'    Skipped (only {len(late)} rows)')
        return None

    X = np.array([make_feature_vector(r) for r in late], dtype=np.float64)
    y = np.array([
        1 if (r.get('ppgPosRank') or 999) <= boom_rank else 0
        for r in late
    ])
    seasons = [r['season'] for r in late]
    n = len(late)
    base_rate = float(y.mean())

    if y.sum() < 10:
        print(f'    Skipped (only {int(y.sum())} booms)')
        return None

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

    auc = float(roc_auc_score(y, loso))

    q75 = float(np.percentile(loso, 75))
    q25 = float(np.percentile(loso, 25))
    high_mask = loso >= q75
    low_mask = loso <= q25
    high_boom_rate = float(y[high_mask].mean()) if high_mask.any() else 0.0
    low_boom_rate = float(y[low_mask].mean()) if low_mask.any() else 0.0

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

    imp = final_model.feature_importance(importance_type='gain')
    total_imp = max(1, sum(imp))
    importance = [
        {'key': k, 'importance': round(float(v / total_imp), 4)}
        for k, v in sorted(zip(BOOM_FEATURES, imp), key=lambda x: -x[1])
        if v > 0
    ]

    model_str = final_model.model_to_string()

    result = {
        'position': pos,
        'n': n,
        'baseRate': round(base_rate, 4),
        'auc': round(auc, 3),
        'lateRank': late_rank,
        'boomRank': boom_rank,
        'highScoreBoomRate': round(high_boom_rate, 4),
        'lowScoreBoomRate': round(low_boom_rate, 4),
        'separation': round(high_boom_rate / max(0.01, low_boom_rate), 2),
        'featureNames': BOOM_FEATURES,
        'featureImportance': importance[:10],
        'modelString': model_str,
    }

    print(f'    n={n}, booms={int(y.sum())}, base rate={base_rate*100:.0f}%, AUC={auc:.3f}')
    print(f'    thresholds: drafted {pos}{late_rank}+ → top-{boom_rank}')
    print(f'    High score (Q4): {high_boom_rate*100:.0f}% boom')
    print(f'    Low score (Q1):  {low_boom_rate*100:.0f}% boom')
    print(f'    Separation: {high_boom_rate/max(0.01, low_boom_rate):.1f}x')

    return result


def main():
    t0 = time.time()
    print(f'Loading training rows from {CACHE_PATH}...')
    with open(CACHE_PATH) as f:
        rows = json.load(f)['rows']
    print(f'  {len(rows)} rows loaded')

    print('\nComputing positional ranks (ADP, PPG)...')
    compute_positional_ranks(rows)

    results = {}
    for pos in ['QB', 'RB', 'WR', 'TE']:
        print(f'\n  Training {pos} late-boom classifier...')
        result = train_position(rows, pos)
        if result is not None:
            results[pos] = result

    with open(OUTPUT_PATH, 'w') as f:
        json.dump({
            'lateBoomModels': results,
            'thresholds': POS_THRESHOLDS,
            'rankingMethod': 'positional',
        }, f)

    print(f'\n  Cache saved to {OUTPUT_PATH}')
    print(f'\nDone in {time.time()-t0:.1f}s')


if __name__ == '__main__':
    main()
