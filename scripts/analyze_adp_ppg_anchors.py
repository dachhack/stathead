#!/usr/bin/env python3
"""
Compute ADP-anchored PPG tier benchmarks for rookie career tier mapping.

For each position, groups all player-seasons by position-rank from ADP,
then reports mean/median PPG per ADP bucket over recent seasons. Output
is used to pick tier boundaries for the rookie career model.

    python3 scripts/analyze_adp_ppg_anchors.py
"""

import json
from collections import defaultdict
from pathlib import Path

CACHE = Path('public/data/training-rows-cache-v49.json')

# ADP buckets we care about (top-N style)
# Last bucket is "rest" (49+).
BUCKETS = [(1, 5), (6, 12), (13, 24), (25, 36), (37, 48), (49, 999)]
POSITIONS = ['QB', 'RB', 'WR', 'TE']

def pos_rank(rows, season, position):
    """Rank players within position+season by ascending overall ADP,
    return dict of name -> pos_rank (1-based). Uses the row's own adp
    field (the same value the row was trained on)."""
    subset = [r for r in rows if r['season'] == season and r['position'] == position and r.get('adp', 0) > 0]
    subset.sort(key=lambda r: r['adp'])
    return {r['name']: i + 1 for i, r in enumerate(subset)}

def main():
    with open(CACHE) as f:
        data = json.load(f)
    rows = data['rows']
    all_seasons = sorted({r['season'] for r in rows if r['season'] >= 2015})
    recent = [s for s in all_seasons if s >= 2019]  # 2019-2025
    print(f'Seasons in cache: {all_seasons[0]}–{all_seasons[-1]} '
          f'(analyzing {recent[0]}–{recent[-1]})')
    print()

    # For each (season, position), compute per-player pos_rank, then bucket.
    # Per-season buckets get a list of PPG values.
    bucket_ppgs = {pos: [[] for _ in BUCKETS] for pos in POSITIONS}
    # Also track per-season top-12 averages so we can see shift over time
    per_season_top12 = {pos: {} for pos in POSITIONS}

    for season in recent:
        for pos in POSITIONS:
            ranks = pos_rank(rows, season, pos)
            ppgs_by_rank = [(ranks[r['name']], r['rawPPG'])
                            for r in rows
                            if r['season'] == season and r['position'] == pos
                               and r['name'] in ranks]
            for rank, ppg in ppgs_by_rank:
                for i, (lo, hi) in enumerate(BUCKETS):
                    if lo <= rank <= hi:
                        bucket_ppgs[pos][i].append(ppg)
                        break
            # Top-12 mean per season
            top12 = [p for rnk, p in ppgs_by_rank if rnk <= 12]
            if top12:
                per_season_top12[pos][season] = sum(top12) / len(top12)

    # Report
    for pos in POSITIONS:
        print(f'================  {pos}  ({recent[0]}–{recent[-1]})  ================')
        print(f'  {"bucket":<9} {"n":>4}  {"mean":>6}  {"median":>6}  {"p25":>6}  {"p75":>6}  {"min":>5}  {"max":>5}')
        for i, (lo, hi) in enumerate(BUCKETS):
            vals = sorted(bucket_ppgs[pos][i])
            if not vals:
                print(f'  {f"{lo}-{hi}":<9} {0:>4}')
                continue
            n = len(vals)
            mean = sum(vals) / n
            med = vals[n // 2]
            p25 = vals[max(0, n // 4)]
            p75 = vals[min(n - 1, int(n * 0.75))]
            label = f'{lo}-{hi if hi < 999 else "+"}'
            print(f'  {label:<9} {n:>4}  {mean:>6.1f}  {med:>6.1f}  {p25:>6.1f}  {p75:>6.1f}  {vals[0]:>5.1f}  {vals[-1]:>5.1f}')
        print()

        # Per-season top-12 drift — sanity-check for whether anchors shift
        drift = per_season_top12[pos]
        if drift:
            parts = [f'{s}:{drift[s]:.1f}' for s in sorted(drift)]
            print(f'  Top-12 mean PPG by season: {", ".join(parts)}')
        print()

    # Proposed tier thresholds (based on bucket medians) — per position
    print('=====================================================')
    print('  PROPOSED TIER ANCHORS (median PPG per bucket)')
    print('=====================================================')
    print(f'  {"pos":<4} {"Elite(1-5)":>10} {"WR1(6-12)":>10} {"WR2(13-24)":>11} {"WR3(25-36)":>11} {"Flex(37-48)":>12} {"Bench(49+)":>11}')
    for pos in POSITIONS:
        medians = []
        for i in range(len(BUCKETS)):
            vals = sorted(bucket_ppgs[pos][i])
            medians.append(vals[len(vals) // 2] if vals else 0)
        print(f'  {pos:<4} ' + '  '.join(f'{m:>9.1f}' for m in medians))

if __name__ == '__main__':
    main()
