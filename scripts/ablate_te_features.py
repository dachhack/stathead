#!/usr/bin/env python3
"""
TE feature ablation — does adding RSP/PDF/production signals help?

The TE pre-draft model currently uses only 6 features:
  logDraftPick, draftPickPct, draftPickPctOverall, draftClassDepth,
  age, recruitStars

The original A/B (n=55 PDF-era) found no stable PDF lift, but the
2022-2025 classes have meaningfully more RSP/PDF coverage now.
This re-tests each candidate feature one at a time on top of the
current baseline. Also tries the "best 1-2 additions" combined.

    python3 scripts/ablate_te_features.py
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

POS = 'TE'
BASELINE = list(PRE_DRAFT_FEATURES[POS])
CANDIDATES = [
    # RSP family
    'rspDotDraft', 'rspBreadthDraft', 'rspTierOrdinal',
    'rspNComps', 'rspHasData',
    # PDF scout family (rank pair must be added together)
    ['pdfRankOverallMean', 'pdfHasRank'],
    'pdfNStrengths', 'pdfNWeaknesses', 'pdfNRedFlags', 'pdfSentimentNet',
    # Recruiting / production
    'recruitRating',
    'collegeDominatorRating',
    'collegeBreakoutScore',
    'collegeBreakoutAge',
    'collegeUsageOverall',
    'collegeReceptionShare',
    'collegeRecYdsPerGame',
    'collegeRecYdsPerTeamPassAtt',
    'collegeBestRecYds',
    'collegeTeammateScore',
    'collegeTeamTalent',
    # Athletic
    'relativeAthleticScore',
    'speedScore',
    'heightAdjSpeedScore',
    'weight',
    'forty',
]

def to_keys(c):
    return c if isinstance(c, list) else [c]

def main():
    print(f'Loading career rows from {CACHE_PATH}...')
    rows = load_career_rows(CACHE_PATH)
    print(f'  {len(rows)} rows\n')

    print(f'BASELINE TE ({len(BASELINE)} features): {", ".join(BASELINE)}')
    base = train_position(rows, POS, BASELINE, is_post_draft=False)
    if not base:
        print('Baseline training failed.')
        return
    base_r2  = base['cvR2']
    base_mae = base['cvMAE']
    base_rho = base['rankCorr']
    print(f'  R² = {base_r2:.3f}  MAE = {base_mae:.2f}  ρ = {base_rho:.3f}\n')

    print(f'\n{"feature added":<36} {"R²":>7} {"ΔR²":>7}  {"MAE":>5} {"ΔMAE":>6}  {"ρ":>6} {"Δρ":>6}')
    print('-' * 90)
    results = []
    for cand in CANDIDATES:
        keys = to_keys(cand)
        feat_set = BASELINE + keys
        res = train_position(rows, POS, feat_set, is_post_draft=False)
        if not res: continue
        d_r2  = res['cvR2']  - base_r2
        d_mae = res['cvMAE'] - base_mae
        d_rho = res['rankCorr'] - base_rho
        results.append((cand, res['cvR2'], d_r2, res['cvMAE'], d_mae, res['rankCorr'], d_rho))
        label = '+'.join(keys) if isinstance(cand, list) else cand
        print(f'  {label:<34} {res["cvR2"]:>7.3f} {d_r2:>+7.3f}  {res["cvMAE"]:>5.2f} {d_mae:>+6.2f}  {res["rankCorr"]:>6.3f} {d_rho:>+6.3f}')

    # Sort by ΔR² and show top 5
    print('\n=== Top 5 features by ΔR² ===')
    results.sort(key=lambda r: -r[2])
    for r in results[:5]:
        label = '+'.join(to_keys(r[0]))
        print(f'  {label:<34} ΔR² {r[2]:>+.3f}  Δρ {r[6]:>+.3f}')

    # Try combining the top 3 individually-positive ones
    positives = [r[0] for r in results if r[2] >= 0.005]
    if len(positives) >= 2:
        print(f'\n=== Combined: baseline + {", ".join(to_keys(c)[0] for c in positives[:3])} ===')
        combo_keys = []
        for c in positives[:3]:
            combo_keys.extend(to_keys(c))
        feat_set = BASELINE + combo_keys
        res = train_position(rows, POS, feat_set, is_post_draft=False)
        if res:
            d_r2  = res['cvR2']  - base_r2
            d_mae = res['cvMAE'] - base_mae
            d_rho = res['rankCorr'] - base_rho
            print(f'  R² = {res["cvR2"]:.3f}  ΔR² {d_r2:>+.3f}   MAE = {res["cvMAE"]:.2f}  ΔMAE {d_mae:>+.2f}   ρ = {res["rankCorr"]:.3f}  Δρ {d_rho:>+.3f}')

if __name__ == '__main__':
    main()
