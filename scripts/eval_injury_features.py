"""
Injury-feature ablation for the PPG models.

Premise check: PPG = total / games_played, so injury *exposure* is
structurally controlled for in the target. The only signal injury
features should add is *post-injury performance decline* — which is a
real but small effect.

Tests:
  1. For each position, drop each injury feature one-at-a-time, report
     LOSO ΔMAE / ΔR² vs the production baseline.
  2. Drop *all* injury features for that position, see combined effect.
  3. For QB specifically, score Lamar Jackson / Josh Allen / Patrick
     Mahomes with their injury features zeroed and see how predictions
     shift — answers "is the model penalizing them for old injuries?"
"""

import sys, json
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent / 'scripts'))
from train_projection_models import load_rows, sf  # type: ignore
import numpy as np
import warnings
warnings.filterwarnings('ignore')

from eval_ppg_features import (  # type: ignore
    BASELINE, PPG_CONFIG, loso_eval, train_full_model, predict_2026, make_X,
)

INJURY_FEATS = {
    'QB': ['priorInjuryWeeks', 'injuryRecurrence', 'priorKneeInjury'],
    'RB': [],  # baseline has none
    'WR': ['priorInjuryWeeks', 'injuryRecurrence', 'priorLateSeasonInjWeeks'],
    'TE': ['priorLateSeasonInjWeeks'],
}

# Players to inspect for QB predict-time effect of zeroing injury features
INSPECT_QB = [
    'Josh Allen', 'Lamar Jackson', 'Patrick Mahomes', 'Trevor Lawrence',
    'Jalen Hurts', 'Jared Goff', 'Justin Herbert', 'Joe Burrow',
]


def main():
    print('Loading rows…')
    all_rows = load_rows()
    fm = json.load(open('public/data/feature-matrix.json'))
    pred_rows = fm['predRows']

    for pos in ['QB', 'WR', 'TE']:
        injs = INJURY_FEATS[pos]
        if not injs:
            continue
        cfg = PPG_CONFIG[pos]
        pos_rows = [r for r in all_rows if r['position'] == pos and r.get('adp', 999) <= 250]
        baseline_feats = BASELINE[pos]
        print(f'\n=== {pos} (n={len(pos_rows)}) — injury features: {injs} ===')

        b = loso_eval(pos_rows, baseline_feats, cfg)
        print(f'  baseline             MAE {b["mae"]:.3f}  R² {b["r2"]:.3f}')

        # Drop one at a time
        for f in injs:
            feats = [x for x in baseline_feats if x != f]
            ev = loso_eval(pos_rows, feats, cfg)
            d_mae = ev['mae'] - b['mae']
            d_r2 = ev['r2'] - b['r2']
            marker = '✓ drop helps' if d_mae < -0.005 else ('✗ keep' if d_mae > 0.005 else '· neutral')
            print(f'  drop {f:<28} MAE {ev["mae"]:.3f}  ΔMAE {d_mae:+.3f}  ΔR² {d_r2:+.3f}  {marker}')

        # Drop all
        feats_all = [x for x in baseline_feats if x not in injs]
        ev_all = loso_eval(pos_rows, feats_all, cfg)
        d_mae = ev_all['mae'] - b['mae']
        d_r2 = ev_all['r2'] - b['r2']
        marker = '✓ drop all helps' if d_mae < -0.005 else ('✗ keep all' if d_mae > 0.005 else '· neutral')
        print(f'  drop ALL injury features  MAE {ev_all["mae"]:.3f}  ΔMAE {d_mae:+.3f}  ΔR² {d_r2:+.3f}  {marker}')

    # QB-specific: which players are most affected by injury features?
    print('\n=== QB: per-player effect of zeroing injury features ===')
    cfg = PPG_CONFIG['QB']
    pos_rows = [r for r in all_rows if r['position'] == 'QB' and r.get('adp', 999) <= 250]
    pos_pred_rows = [r for r in pred_rows if r['position'] == 'QB' and r.get('adp', 999) <= 250]
    baseline_feats = BASELINE['QB']

    # Train baseline on full data, predict 2026
    m = train_full_model(pos_rows, baseline_feats, cfg)
    pred_normal = predict_2026(m, pos_pred_rows)

    # Predict 2026 with injury features zeroed
    pred_rows_zeroed = []
    for r in pos_pred_rows:
        rc = dict(r)
        rc['features'] = dict(r['features'])
        for f in INJURY_FEATS['QB']:
            rc['features'][f] = 0
        pred_rows_zeroed.append(rc)
    pred_zero = predict_2026(m, pred_rows_zeroed)

    print(f'  {"player":<22} {"adp":>6} {"normal":>8} {"injury=0":>10} {"Δ":>7} {"priorInjuryWeeks":>18} {"kneeInj":>9} {"recurrence":>11}')
    for name in INSPECT_QB:
        for i, r in enumerate(pos_pred_rows):
            if r['name'] == name:
                pn = pred_normal[i]
                pz = pred_zero[i]
                feats = r['features']
                print(f'  {name:<22} {r.get("adp", 999):>6.1f} {pn:>8.1f} {pz:>10.1f} {pz - pn:>+7.1f} '
                      f'{feats.get("priorInjuryWeeks", 0):>18} {feats.get("priorKneeInjury", 0):>9} '
                      f'{feats.get("injuryRecurrence", 0):>11}')
                break


if __name__ == '__main__':
    main()
