"""
Forward-selection: do ppgTrend2yr / 3yr / 4yr help the QB PPG model?

Baseline = current production feature list (with `ppgTrend`).
Variants:
  baseline + ppgTrend3yr
  baseline + ppgTrend4yr
  baseline + ppgTrend3yr + ppgTrend4yr
  baseline replacing ppgTrend with ppgTrend4yr (test "smooth long view")

Reports LOSO MAE / R² and Lamar's prediction shift for each.
"""
import sys, json
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent / 'scripts'))
from train_projection_models import load_rows  # type: ignore
import warnings
warnings.filterwarnings('ignore')

from eval_ppg_features import BASELINE, PPG_CONFIG, loso_eval, train_full_model, predict_2026  # type: ignore

CANDIDATES = [
    ('baseline',                                    BASELINE['QB']),
    ('+ ppgTrend3yr',                              BASELINE['QB'] + ['ppgTrend3yr']),
    ('+ ppgTrend4yr',                              BASELINE['QB'] + ['ppgTrend4yr']),
    ('+ ppgTrend3yr + ppgTrend4yr',                BASELINE['QB'] + ['ppgTrend3yr', 'ppgTrend4yr']),
    ('replace ppgTrend with ppgTrend4yr',          [f for f in BASELINE['QB'] if f != 'ppgTrend'] + ['ppgTrend4yr']),
    ('replace ppgTrend with ppgTrend3yr',          [f for f in BASELINE['QB'] if f != 'ppgTrend'] + ['ppgTrend3yr']),
    ('all three trends, no other changes',         [f for f in BASELINE['QB'] if f != 'ppgTrend'] + ['ppgTrend2yr', 'ppgTrend3yr', 'ppgTrend4yr']),
]


def main():
    print('Loading rows…')
    all_rows = load_rows()
    fm = json.load(open('public/data/feature-matrix.json'))
    pred_rows = fm['predRows']

    cfg = PPG_CONFIG['QB']
    qb_train = [r for r in all_rows if r['position'] == 'QB' and r.get('adp', 999) <= 250]
    qb_pred = [r for r in pred_rows if r['position'] == 'QB' and r.get('adp', 999) <= 250]

    print(f'\n{"variant":<44} {"MAE":>9} {"ΔMAE":>9} {"R²":>9} {"Lamar":>8}')
    base_mae = None
    for label, feats in CANDIDATES:
        e = loso_eval(qb_train, feats, cfg)
        m = train_full_model(qb_train, feats, cfg)
        preds = predict_2026(m, qb_pred)
        lamar_pred = next((p for r, p in zip(qb_pred, preds) if r['name'] == 'Lamar Jackson'), None)
        if base_mae is None:
            base_mae = e['mae']
        d = e['mae'] - base_mae
        marker = '✓' if d < -0.005 else ('·' if abs(d) <= 0.005 else '✗')
        print(f'  {label:<42} {e["mae"]:>9.3f} {d:>+9.3f} {e["r2"]:>9.3f} {lamar_pred:>8.1f}  {marker}')

    # Summary: also show Lamar's feature values
    lamar = next(r for r in qb_pred if r['name'] == 'Lamar Jackson')
    print(f'\nLamar feature values:')
    for k in ['priorPPG', 'priorPPG2yr', 'ppgTrend', 'ppgTrend2yr', 'ppgTrend3yr', 'ppgTrend4yr']:
        v = lamar['features'].get(k)
        print(f'  {k:<20} = {v}')


if __name__ == '__main__':
    main()
