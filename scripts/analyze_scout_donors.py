#!/usr/bin/env python3
"""
Find donor features for imputing scout signals on pre-2022 rookies.

For each scout target (pdfRankOverallMean, rspDotDraft, rspTierOrdinal,
rspNComps, rspBreadthDraft), computes:

  coverage  — fraction of pre-2022 rookies with a non-zero donor value
              (we need the donor populated historically)
  pearson   — Pearson correlation with the target, computed on the
              2022+ cohort where the target is populated

The ideal donor has both high coverage pre-2022 AND high correlation on
the modern subset — it then substitutes cleanly for the missing modern
scout signal in historical predictions.

    python3 scripts/analyze_scout_donors.py
"""

import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from train_career_models import load_career_rows, CACHE_PATH

POSITIONS = ['QB', 'RB', 'WR', 'TE']

# pdfRankOverallMean: lower = better scout rank. For correlation purposes
# we want a donor that correlates NEGATIVELY with pick position too (earlier
# picks → lower rank = better). So nflDraftPick should positively correlate
# with pdfRankOverallMean (later pick → worse scout rank).
TARGETS = [
    'pdfRankOverallMean', 'rspDotDraft', 'rspTierOrdinal',
    'rspNComps', 'rspBreadthDraft',
]

# Donor candidates — all should be populated for historical players too.
DONORS = [
    'nflDraftPick', 'logDraftPick', 'draftPickPctOverall', 'draftPickPct',
    'nflDraftRound', 'recruitRating', 'recruitStars',
    'collegeDominatorRating', 'collegeBestRecYds', 'collegeBestRushYds',
    'collegeRushYds', 'collegeRecYds',
    'age', 'weight', 'forty', 'relativeAthleticScore',
    'collegeBreakoutAge', 'collegeBreakoutScore',
    'draftClassDepth', 'collegeSeasons', 'collegeEarlyDeclare',
    'speedScore', 'collegeTeamTalent',
]

def pearson(xs, ys):
    n = len(xs)
    if n < 5:
        return 0, 0
    mx = sum(xs) / n
    my = sum(ys) / n
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    dx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    dy = math.sqrt(sum((y - my) ** 2 for y in ys))
    if dx == 0 or dy == 0:
        return 0, n
    return num / (dx * dy), n

def main():
    print(f'Loading {CACHE_PATH}...')
    rows = load_career_rows(CACHE_PATH)
    print(f'  {len(rows)} rows\n')

    for pos in POSITIONS:
        pos_rows = [r for r in rows if r['position'] == pos]
        pre = [r for r in pos_rows if r['draft_season'] < 2022]
        mod = [r for r in pos_rows if r['draft_season'] >= 2022]

        print(f'{"=" * 78}')
        print(f'  {pos}  (pre-2022 n={len(pre)}, 2022+ n={len(mod)})')
        print(f'{"=" * 78}')

        for target in TARGETS:
            # Skip if target is never present even for 2022+ in this position
            mod_with_target = [r for r in mod
                                if r['features'].get(target, 0) not in (0, None)]
            if len(mod_with_target) < 5:
                continue

            print(f'\n  Target: {target}   (n=2022+ present: {len(mod_with_target)}/{len(mod)})')
            print(f'    {"donor":<32} {"pre-cov":>7} {"r(2022+)":>9}  {"r*cov":>7}')

            scored = []
            for donor in DONORS:
                pre_cov = sum(
                    1 for r in pre
                    if r['features'].get(donor, 0) not in (0, None)
                ) / max(len(pre), 1)
                # Correlation on the modern subset with both target and donor present
                paired = [
                    (
                        float(r['features'].get(donor, 0) or 0),
                        float(r['features'].get(target, 0) or 0),
                    )
                    for r in mod
                    if r['features'].get(donor, 0) not in (0, None)
                    and r['features'].get(target, 0) not in (0, None)
                ]
                if len(paired) < 8:
                    continue
                xs = [p[0] for p in paired]
                ys = [p[1] for p in paired]
                r_val, _ = pearson(xs, ys)
                scored.append((donor, pre_cov, r_val, abs(r_val) * pre_cov))

            scored.sort(key=lambda x: -x[3])
            for d, cov, r_val, score in scored[:8]:
                print(f'    {d:<32} {cov * 100:>5.0f}%  {r_val:>+8.3f}  {score:>+6.3f}')

if __name__ == '__main__':
    main()
