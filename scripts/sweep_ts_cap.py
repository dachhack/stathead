#!/usr/bin/env python3
"""
Sweep caps on collegeTeammateScore for WR to see if clipping the
long tail reduces Jameson-style over-predictions without hurting R².

    python3 scripts/sweep_te_score_cap.py
"""

import sys, os
from pathlib import Path

# Patch in a clipping monkey-patch via env var before importing the trainer.
CAP = float(os.environ.get('TS_CAP', '0'))
if CAP <= 0:
    print('Set TS_CAP env var to test, e.g.  TS_CAP=1.5 python3 scripts/sweep_te_score_cap.py')

sys.path.insert(0, str(Path(__file__).parent))
from train_career_models import (
    load_career_rows, train_position, CACHE_PATH, PRE_DRAFT_FEATURES
)

rows = load_career_rows(CACHE_PATH)
print(f'\n=== TS cap = {CAP if CAP else "baseline"} ===')
for r in rows:
    if r['position'] != 'WR': continue
    ts = r['features'].get('collegeTeammateScore', 0) or 0
    if CAP > 0 and ts > CAP:
        r['features']['collegeTeammateScore'] = CAP

res = train_position(rows, 'WR', PRE_DRAFT_FEATURES['WR'], is_post_draft=False)
print(f"R²={res['cvR2']:.3f}  MAE={res['cvMAE']:.2f}  rho={res['rankCorr']:.3f}")

# Jameson + neighbors
names = ['Jameson Williams','DeVonta Smith','Jaylen Waddle','John Metchie III',
         'Chris Olave','Garrett Wilson','Malik Nabers','Marvin Harrison',
         'Treylon Burks','Jahan Dotson']
for r in res['backtestRows']:
    if r['name'] in names:
        print(f"  {r['name']:<24} {r['draftSeason']} pred={r['predictedPPG']:>5.1f} actual={r['actualPPG']:>5.1f}")
