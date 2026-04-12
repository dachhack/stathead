#!/usr/bin/env python3
"""Feature ablation for the KTC time-series models (Commit C).

For each (position, horizon) pair, measure the marginal Δ pgR² when each
feature is dropped from the input vector. Uses player-grouped CV (the
primary metric for long horizons, and a valid secondary metric for short
horizons) so every (pos, H) pair is measured on the same scale.

Pipeline:
  1. Load and assemble the full dataset for each (pos, H) once (matches
     scripts/train_ktc_timeseries.py's build_dataset output byte-for-byte).
  2. Compute a baseline pgR² on all 73 features.
  3. For each feature index, train K=5 player-grouped folds with that
     column removed from X and feature_names — not zeroed, so the GBM
     doesn't waste leaves on a constant column. Record ΔpgR² = baseline - ablated.
  4. Emit public/data/ktc-feature-ablation.json with per-(pos, H) rank
     tables and a top-level "feature group summary" (fast / slow / weekly).

Runtime: ~20-30 minutes on /tmp/lgb-verify (20 models × 74 fits × 5 folds).

Usage:
    source /tmp/lgb-verify/bin/activate
    python3 scripts/ablate_ktc_features.py           # all positions, all H
    python3 scripts/ablate_ktc_features.py --pos RB  # just RB
    python3 scripts/ablate_ktc_features.py --horizon 90  # just H=90
    python3 scripts/ablate_ktc_features.py --top 10     # summary head only
"""
import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
from sklearn.metrics import r2_score

sys.path.insert(0, str(Path(__file__).parent))
from train_ktc_timeseries import (  # noqa: E402
    POSITIONS, HORIZONS, BASE_LGB_PARAMS, BASE_N_ROUNDS, PLAYER_CV_FOLDS,
    MIN_FOLD_TRAIN_ROWS,
    FAST_FEATURE_NAMES, SLOW_COMMON, SLOW_POS, WEEKLY_FEATURE_NAMES,
    load_inputs, compute_fast_features_all, fill_rank_features,
    load_weekly_cache, build_dataset,
)
from train_projection_models import train_lgb_model  # noqa: E402


OUTPUT_PATH = Path('public/data/ktc-feature-ablation.json')


def player_grouped_cv_for_ablation(X, y, pids, feature_names,
                                      lgb_params, n_rounds):
    """K-fold player-grouped CV, pooled R² over all folds.

    Simplified copy of train_ktc_timeseries.player_grouped_cv: we don't
    care about per-fold verbose output or valid_fold counting, just the
    pooled cvR² — which is all we need for a Δ signal.
    """
    if len(X) < MIN_FOLD_TRAIN_ROWS * 2:
        return float('nan')

    unique_pids = np.unique(pids)
    if len(unique_pids) < PLAYER_CV_FOLDS * 2:
        return float('nan')

    rng = np.random.default_rng(42)   # same seed as train_ktc_timeseries
    shuffled = rng.permutation(unique_pids)
    fold_of_pid = {pid: i % PLAYER_CV_FOLDS for i, pid in enumerate(shuffled)}
    fold_assign = np.array([fold_of_pid[p] for p in pids], dtype=np.int64)

    all_preds = []
    all_actuals = []

    for k in range(PLAYER_CV_FOLDS):
        train_mask = fold_assign != k
        test_mask = fold_assign == k
        if train_mask.sum() < MIN_FOLD_TRAIN_ROWS or test_mask.sum() < 10:
            continue
        booster = train_lgb_model(X[train_mask], y[train_mask], feature_names,
                                    lgb_params, n_rounds)
        preds = booster.predict(X[test_mask])
        all_preds.extend(preds.tolist())
        all_actuals.extend(y[test_mask].tolist())

    if len(all_preds) < 10:
        return float('nan')
    return float(r2_score(np.array(all_actuals), np.array(all_preds)))


def classify_feature(name):
    """Assign a feature to a group. Kept in sync with the groups emitted
    in scripts/train_ktc_timeseries.py's FEATURE metadata."""
    if name in FAST_FEATURE_NAMES:
        return 'fast'
    if name in SLOW_COMMON:
        return 'slow_common'
    if name in WEEKLY_FEATURE_NAMES:
        return 'weekly'
    for pos, keys in SLOW_POS.items():
        if name in keys:
            return f'slow_{pos.lower()}'
    return 'unknown'


def ablate_pair(pos, horizon, players, fast_by_pid, slow_by_pid,
                weekly_by_key, wcd, verbose=False):
    """Ablate one (position, horizon) pair. Returns dict with baseline
    pgR² + per-feature ablation results sorted by Δ descending."""
    t0 = time.time()
    X, y, t_arr, pids, feature_names = build_dataset(
        pos, horizon, players, fast_by_pid, slow_by_pid, weekly_by_key, wcd)
    build_time = time.time() - t0
    n = len(y)

    if n < 100:
        print(f'  {pos} H={horizon}: n={n} — SKIPPED (too few rows)')
        return None

    # Baseline: all 73 features
    t0 = time.time()
    baseline = player_grouped_cv_for_ablation(
        X, y, pids, feature_names, BASE_LGB_PARAMS, BASE_N_ROUNDS)
    base_time = time.time() - t0

    print(f'  {pos} H={horizon:3d}: n={n:6d} baseline pgR²={baseline:+.4f}  '
          f'(build {build_time:.1f}s, baseline {base_time:.1f}s, '
          f'ablating {len(feature_names)} features...)', flush=True)

    # Per-feature ablation: drop column i, refit K folds
    results = []
    t0 = time.time()
    for i, fname in enumerate(feature_names):
        keep_cols = [j for j in range(len(feature_names)) if j != i]
        X_ablated = X[:, keep_cols]
        names_ablated = [feature_names[j] for j in keep_cols]
        pg_r2 = player_grouped_cv_for_ablation(
            X_ablated, y, pids, names_ablated, BASE_LGB_PARAMS, BASE_N_ROUNDS)
        delta = baseline - pg_r2
        results.append({
            'feature': fname,
            'group': classify_feature(fname),
            'pgR2_without': round(pg_r2, 4) if not np.isnan(pg_r2) else None,
            'delta': round(delta, 4) if not np.isnan(delta) else None,
        })
        if verbose:
            print(f'    [{i+1:>2}/{len(feature_names)}] {fname:<28} '
                  f'pgR²={pg_r2:+.4f}  Δ={delta:+.4f}')

    ablate_time = time.time() - t0
    results.sort(key=lambda r: -(r['delta'] or -999))

    print(f'    ablation done in {ablate_time:.1f}s '
          f'(top: {results[0]["feature"]} Δ={results[0]["delta"]:+.4f}; '
          f'bottom: {results[-1]["feature"]} Δ={results[-1]["delta"]:+.4f})')

    return {
        'position': pos,
        'horizon': horizon,
        'n': int(n),
        'nFeatures': len(feature_names),
        'baseline_pgR2': round(baseline, 4),
        'results': results,
    }


def summarize_by_group(all_results):
    """Aggregate per-feature Δ by group, across all (pos, H) pairs."""
    group_totals = {}
    for (pos, h), entry in all_results.items():
        if entry is None:
            continue
        for r in entry['results']:
            g = r['group']
            delta = r['delta'] or 0.0
            key = (g, r['feature'])
            group_totals.setdefault(key, []).append(delta)
    # Aggregate
    agg = {}
    for (g, feat), deltas in group_totals.items():
        agg.setdefault(g, {})[feat] = {
            'meanDelta': round(float(np.mean(deltas)), 4),
            'stdDelta': round(float(np.std(deltas)), 4),
            'nModels': len(deltas),
            'netPositive': int(sum(1 for d in deltas if d > 0.001)),
            'netNegative': int(sum(1 for d in deltas if d < -0.001)),
        }
    return agg


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--pos', type=str, default=None,
                        help='Only ablate this position (QB/RB/WR/TE)')
    parser.add_argument('--horizon', type=int, default=None,
                        help='Only ablate this horizon')
    parser.add_argument('--top', type=int, default=10,
                        help='Print the top-N features per (pos, H)')
    parser.add_argument('--verbose', action='store_true',
                        help='Print per-feature progress during ablation')
    args = parser.parse_args()

    print('Loading KTC + nflverse + training cache...')
    players, slow_by_pid, date_grid = load_inputs()
    fast_by_pid = compute_fast_features_all(players)
    fill_rank_features(players, fast_by_pid, date_grid)
    weekly_by_key, wcd = load_weekly_cache()
    print(f'  {len(players)} players, {len(fast_by_pid)} with fast features, '
          f'{len(weekly_by_key)} with weekly data')
    print()

    pairs = []
    for pos in POSITIONS:
        if args.pos and pos != args.pos.upper():
            continue
        for h in HORIZONS:
            if args.horizon and h != args.horizon:
                continue
            pairs.append((pos, h))
    print(f'Running ablation on {len(pairs)} (position, horizon) pairs...')
    print()

    t_start = time.time()
    all_results = {}
    for pos, h in pairs:
        entry = ablate_pair(pos, h, players, fast_by_pid, slow_by_pid,
                             weekly_by_key, wcd, verbose=args.verbose)
        all_results[(pos, h)] = entry

    elapsed = time.time() - t_start
    print()
    print(f'=== Ablation complete in {elapsed:.1f}s ===')
    print()

    # Per-(pos, H) top-N summary
    print(f'Top {args.top} features by Δ pgR² per (position, horizon):')
    print()
    for (pos, h), entry in all_results.items():
        if entry is None:
            continue
        print(f'  {pos} H={h:3d} (baseline pgR²={entry["baseline_pgR2"]:+.4f}, n={entry["n"]})')
        for rank, r in enumerate(entry['results'][:args.top], 1):
            delta = r['delta'] or 0.0
            tag = ('IMPORTANT' if delta > 0.005
                   else 'useful' if delta > 0.001
                   else 'redundant' if delta > -0.001
                   else 'NOISE (drop helps)')
            print(f'    {rank:>2} {r["feature"]:<30} [{r["group"]:<12}] '
                  f'Δ={delta:+.4f}  {tag}')
        # Also print dead tail
        dead_tail = [r for r in entry['results'] if (r['delta'] or 0) < -0.002]
        if dead_tail:
            print(f'    NEGATIVE-Δ features (dropping improves model):')
            for r in dead_tail[-5:]:
                print(f'       {r["feature"]:<28} [{r["group"]:<12}] Δ={r["delta"]:+.4f}')
        print()

    # Cross-model group summary
    print('─' * 70)
    print('Per-feature mean Δ across the (pos, H) pairs that ran:')
    print()
    group_agg = summarize_by_group(all_results)
    for g in sorted(group_agg.keys()):
        feats = sorted(group_agg[g].items(), key=lambda kv: -kv[1]['meanDelta'])
        print(f'  [{g}]')
        for feat, stats in feats:
            print(f'    {feat:<30} meanΔ={stats["meanDelta"]:+.4f}  '
                  f'±{stats["stdDelta"]:.4f}  pos/neg/n={stats["netPositive"]}/'
                  f'{stats["netNegative"]}/{stats["nModels"]}')
        print()

    # Serialize
    serializable = {
        f'{pos}_H{h}': entry
        for (pos, h), entry in all_results.items() if entry is not None
    }
    output = {
        'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'schemaVersion': 1,
        'baseLgbParams': {k: v for k, v in BASE_LGB_PARAMS.items()},
        'baseNRounds': BASE_N_ROUNDS,
        'playerGroupedFolds': PLAYER_CV_FOLDS,
        'pairs': serializable,
        'groupSummary': group_agg,
    }
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_PATH, 'w') as f:
        json.dump(output, f, indent=2)
    size_mb = OUTPUT_PATH.stat().st_size / 1024 / 1024
    print(f'Wrote {OUTPUT_PATH} ({size_mb:.2f} MB)')


if __name__ == '__main__':
    main()
