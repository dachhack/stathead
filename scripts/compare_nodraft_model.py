#!/usr/bin/env python3
"""
Ad-hoc comparison: rookie career model WITH vs WITHOUT draft-pick info.

Strips the player-specific draft-pick features (logDraftPick,
draftPickPct, draftPickPctOverall, collegeDominatorXLateRound) from
PRE_DRAFT_FEATURES and retrains RB/WR/TE. Reports LOSO regression
metrics + boom/bust calibration side-by-side.

Uses the LightGBM Python trainer (~50-100x faster than the TS fallback).

    python3 scripts/compare_nodraft_model.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from train_career_models import (
    PRE_DRAFT_FEATURES,
    CACHE_PATH,
    load_career_rows,
    train_position,
)

POSITIONS = ['RB', 'WR', 'TE']

DRAFT_KEYS_TO_STRIP = {
    'logDraftPick',
    'draftPickPct',
    'draftPickPctOverall',
    'collegeDominatorXLateRound',
}

def calibration(bt_rows, prob_field, boom_thresh):
    """Bucket backtest rows by predicted prob; return (band, n, mean_pred, actual_hit%)."""
    edges = [0, 10, 25, 50, 75, 101]
    def hit(r):
        err = r['actualPPG'] - r['predictedPPG']
        return (err > boom_thresh) if prob_field == 'boomProb' else (err < -boom_thresh)
    out = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        bucket = [r for r in bt_rows if lo <= r.get(prob_field, 0) < hi]
        if not bucket:
            out.append((f'{lo}-{hi if hi < 101 else 100}', 0, 0.0, 0.0))
            continue
        mp = sum(r.get(prob_field, 0) for r in bucket) / len(bucket)
        act = sum(1 for r in bucket if hit(r)) / len(bucket) * 100
        out.append((f'{lo}-{hi if hi < 101 else 100}', len(bucket), mp, act))
    return out

def fmt_cal(cal):
    return '  '.join(f'{b}: n={n:>2} pred={mp:>4.1f} act={act:>3.0f}%' for b, n, mp, act in cal)

def report(pos, base, nod):
    stripped = [k for k in base['featureKeys'] if k not in nod['featureKeys']]
    added   = [k for k in nod['featureKeys'] if k not in base['featureKeys']]
    print()
    print(f'================  {pos}  ================')
    print(f'  features: baseline={len(base["featureKeys"])} noDraft={len(nod["featureKeys"])}')
    print(f'  stripped: {", ".join(stripped) or "(none)"}')
    if added:
        print(f'  added:    {", ".join(added)}')
    print()
    print(f'  metric              baseline    noDraft     Δ')
    print(f'  R²                  {base["cvR2"]:>8.3f}   {nod["cvR2"]:>8.3f}   {nod["cvR2"]-base["cvR2"]:>+7.3f}')
    print(f'  MAE                 {base["cvMAE"]:>8.2f}   {nod["cvMAE"]:>8.2f}   {nod["cvMAE"]-base["cvMAE"]:>+7.2f}')
    print(f'  rank corr           {base["rankCorr"]:>8.3f}   {nod["rankCorr"]:>8.3f}   {nod["rankCorr"]-base["rankCorr"]:>+7.3f}')
    print(f'  boom rate (%)       {base["boomRate"]:>8.1f}   {nod["boomRate"]:>8.1f}')
    print(f'  bust rate (%)       {base["bustRate"]:>8.1f}   {nod["bustRate"]:>8.1f}')
    print()

    # Calibration uses each model's own MAE as the boom/bust threshold,
    # matching the training code (boom_thresh = mae * 0.75 in the LOSO bins).
    b_thresh = base['cvMAE'] * 0.75
    n_thresh = nod['cvMAE'] * 0.75
    print(f'  Boom calibration (boomProb band → actual outperform rate)')
    print(f'    baseline (thresh={b_thresh:.1f} PPG): {fmt_cal(calibration(base["backtestRows"], "boomProb", b_thresh))}')
    print(f'    noDraft  (thresh={n_thresh:.1f} PPG): {fmt_cal(calibration(nod["backtestRows"],  "boomProb", n_thresh))}')
    print()
    print(f'  Bust calibration (bustProb band → actual bust rate)')
    print(f'    baseline: {fmt_cal(calibration(base["backtestRows"], "bustProb", b_thresh))}')
    print(f'    noDraft : {fmt_cal(calibration(nod["backtestRows"],  "bustProb", n_thresh))}')

    # Top features by importance
    print(f'\n  Top 8 importance — baseline    vs    noDraft')
    for i in range(8):
        bi = base['featureImportance'][i] if i < len(base['featureImportance']) else None
        ni = nod['featureImportance'][i]  if i < len(nod['featureImportance'])  else None
        bs = f"{bi['key']:<30} {bi['importance']:.3f}" if bi else ''
        ns = f"{ni['key']:<30} {ni['importance']:.3f}" if ni else ''
        print(f'    {bs:<40}  {ns}')

def main():
    print(f'Loading training rows from {CACHE_PATH}...')
    career_rows = load_career_rows(CACHE_PATH)
    print(f'  {len(career_rows)} career rows\n')

    originals = {p: list(PRE_DRAFT_FEATURES[p]) for p in POSITIONS}
    results = {}

    for pos in POSITIONS:
        print(f'[{pos}] baseline ({len(originals[pos])} features)...')
        base = train_position(career_rows, pos, originals[pos], is_post_draft=False)

        stripped = [k for k in originals[pos] if k not in DRAFT_KEYS_TO_STRIP]
        print(f'[{pos}] noDraft  ({len(stripped)} features)...')
        nod  = train_position(career_rows, pos, stripped, is_post_draft=False)

        if base and nod:
            results[pos] = (base, nod)

    print('\n\n=====================================================')
    print('         SUMMARY: baseline  vs  noDraft')
    print('=====================================================')
    for pos in POSITIONS:
        if pos in results:
            report(pos, *results[pos])

if __name__ == '__main__':
    main()
