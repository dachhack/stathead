"""
Diagnostic: how does the model compare to naive baselines, and which
single-feature additions actually help?

Naive baselines:
  - Predict mean PPG always (the dumbest possible model)
  - Predict priorPPG (last year actual)
  - Predict 0.6*priorPPG + 0.4*priorPPG2yr + age curve (the redraft-
    projections formula)

Then forward-selection: starting from baseline features, try adding
each candidate feature one at a time. Report which ones help.
"""

import sys, json
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent / 'scripts'))
from train_projection_models import load_rows, sf, train_lgb_model  # type: ignore
import numpy as np
from sklearn.metrics import r2_score, mean_absolute_error
import warnings
warnings.filterwarnings('ignore')

from eval_ppg_features import (  # type: ignore
    BASELINE, CANDIDATES, PPG_CONFIG, loso_eval, top12_metrics,
)


def naive_metrics(rows):
    """Compare baselines: mean / priorPPG / weighted prior."""
    y = np.array([sf(r.get('rawPPG', 0)) for r in rows])

    def report(name, pred, mask=None):
        if mask is None:
            mask = np.ones_like(y, dtype=bool)
        m = mae = r2 = None
        try:
            mae = mean_absolute_error(y[mask], pred[mask])
            r2 = r2_score(y[mask], pred[mask])
            return name, len(y[mask]), mae, r2
        except Exception:
            return name, 0, 0, 0

    # Mean (per-position constant predictor)
    pred_mean = np.full(len(y), y.mean())

    # priorPPG (last year actual)
    prior = np.array([sf(r['features'].get('priorPPG', 0)) for r in rows])
    valid = prior > 0
    n1, m1, r1 = report('priorPPG only', prior, valid)[1:]

    # priorPPG2yr (weighted 0.65*Y-1 + 0.35*Y-2)
    prior2 = np.array([sf(r['features'].get('priorPPG2yr', 0)) for r in rows])
    valid2 = prior2 > 0
    n2, m2, r2 = report('priorPPG2yr only', prior2, valid2)[1:]

    return [
        ('mean (constant)',                len(y), mean_absolute_error(y, pred_mean), r2_score(y, pred_mean)),
        ('priorPPG only',                  n1, m1, r1),
        ('priorPPG2yr only',               n2, m2, r2),
    ]


def main():
    print('Loading rows…')
    all_rows = load_rows()

    print('\n' + '=' * 86)
    print('NAIVE BASELINES — what do trivial models score?')
    print('=' * 86)
    for pos in ['QB', 'RB', 'WR', 'TE']:
        cfg = PPG_CONFIG[pos]
        pos_rows = [r for r in all_rows if r['position'] == pos and r.get('adp', 999) <= 250]
        print(f'\n— {pos} (n={len(pos_rows)}) —')
        for name, n, mae, r2 in naive_metrics(pos_rows):
            print(f'  {name:<28}  n={n:<5}  MAE={mae:.3f}  R²={r2:+.3f}')
        # Compare to current model baseline (from cache)
        b = loso_eval(pos_rows, BASELINE[pos], cfg)
        print(f'  {"current model (LOSO)":<28}  n={b["n"]:<5}  MAE={b["mae"]:.3f}  R²={b["r2"]:+.3f}')

    print('\n' + '=' * 86)
    print('FORWARD SELECTION (QB only, since it\'s the broken one)')
    print('=' * 86)
    cfg = PPG_CONFIG['QB']
    pos_rows = [r for r in all_rows if r['position'] == 'QB' and r.get('adp', 999) <= 250]
    base = loso_eval(pos_rows, BASELINE['QB'], cfg)
    print(f'baseline (no candidate): MAE={base["mae"]:.3f}  R²={base["r2"]:+.3f}')
    print()
    print('Adding ONE candidate feature at a time, ranked by Δ MAE (negative = better):')
    print(f'  {"feature":<28} {"MAE":>9} {"ΔMAE":>9} {"R²":>9} {"ΔR²":>9}')
    results = []
    for feat in CANDIDATES['QB']:
        if feat in BASELINE['QB']:
            continue
        feats = BASELINE['QB'] + [feat]
        ev = loso_eval(pos_rows, feats, cfg)
        d_mae = ev['mae'] - base['mae']
        d_r2 = ev['r2'] - base['r2']
        results.append((feat, ev['mae'], d_mae, ev['r2'], d_r2))
    results.sort(key=lambda t: t[2])
    for feat, mae, d_mae, r2, d_r2 in results:
        marker = '✓' if d_mae < -0.005 else ('·' if abs(d_mae) <= 0.005 else '✗')
        print(f'  {feat:<28} {mae:>9.3f} {d_mae:>+9.3f} {r2:>9.3f} {d_r2:>+9.3f}  {marker}')


if __name__ == '__main__':
    main()
