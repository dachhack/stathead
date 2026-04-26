"""
Train QB PPG model with and without injury features, score 2026 QBs,
and compare predictions side by side.
"""
import sys, json
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent / 'scripts'))
from train_projection_models import load_rows  # type: ignore
import warnings
warnings.filterwarnings('ignore')

from eval_ppg_features import BASELINE, PPG_CONFIG, train_full_model, predict_2026, loso_eval  # type: ignore

INJURY = ['priorInjuryWeeks', 'injuryRecurrence', 'priorKneeInjury']

def main():
    print('Loading rows…')
    all_rows = load_rows()
    fm = json.load(open('public/data/feature-matrix.json'))
    pred_rows = fm['predRows']

    cfg = PPG_CONFIG['QB']
    qb_train = [r for r in all_rows if r['position'] == 'QB' and r.get('adp', 999) <= 250]
    qb_pred = [r for r in pred_rows if r['position'] == 'QB' and r.get('adp', 999) <= 250]

    base = BASELINE['QB']
    no_inj = [f for f in base if f not in INJURY]

    print('LOSO comparison:')
    e_base = loso_eval(qb_train, base, cfg)
    e_new = loso_eval(qb_train, no_inj, cfg)
    print(f'  with injury features:    MAE {e_base["mae"]:.3f}  R² {e_base["r2"]:.3f}')
    print(f'  without injury features: MAE {e_new["mae"]:.3f}  R² {e_new["r2"]:.3f}  (Δ MAE {e_new["mae"]-e_base["mae"]:+.3f})')

    print('\nTraining full models…')
    m_base = train_full_model(qb_train, base, cfg)
    m_new = train_full_model(qb_train, no_inj, cfg)
    p_base = predict_2026(m_base, qb_pred)
    p_new = predict_2026(m_new, qb_pred)

    by_adp = sorted(zip(qb_pred, p_base, p_new), key=lambda t: t[0].get('adp', 999))[:14]
    print(f'\n2026 QB predictions:')
    print(f'  {"player":<22} {"adp":>6} {"with-inj":>10} {"no-inj":>9} {"Δ":>7}')
    for r, pb, pn in by_adp:
        print(f'  {r["name"]:<22} {r.get("adp", 999):>6.1f} {pb:>10.1f} {pn:>9.1f} {pn-pb:>+7.1f}')

    # Summary stats
    bs_top12 = sorted(p_base.tolist(), reverse=True)[:12]
    nw_top12 = sorted(p_new.tolist(), reverse=True)[:12]
    print(f'\nTop-12 prediction range:')
    print(f'  with-inj: {bs_top12[-1]:.1f} to {bs_top12[0]:.1f}  (spread {bs_top12[0]-bs_top12[-1]:.1f})')
    print(f'  no-inj:   {nw_top12[-1]:.1f} to {nw_top12[0]:.1f}  (spread {nw_top12[0]-nw_top12[-1]:.1f})')


if __name__ == '__main__':
    main()
