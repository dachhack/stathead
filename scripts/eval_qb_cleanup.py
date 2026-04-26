"""
QB feature-cleanup ablation. Three threads to pull, in order:

  1. Drop zero-gain injury features (injuryRecurrence, priorKneeInjury).
     Expected: identical metrics (the GBM never used them).

  2. Drop teamSamePosCount (44% of model's gain — possibly spurious).
     Test: does it hurt or help the LOSO MAE?

  3. With the data-pipeline now fixed, re-test raw prior-stat features
     (priorPPG, priorPassTDs, priorPassYards, priorRushTDs, priorRushYards,
     age) one at a time on top of the cleaned baseline.

For each candidate, train a fresh QB ensemble and report LOSO MAE / R².
Final variant: cleaned baseline + the candidate adds that helped on the
last pass. Train + score 2026, show top QB shifts.
"""
import sys, json
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent / 'scripts'))
from train_projection_models import load_rows  # type: ignore
import warnings
warnings.filterwarnings('ignore')

from eval_ppg_features import PPG_CONFIG, loso_eval, train_full_model, predict_2026  # type: ignore

# Current production baseline (post-#246 retrain).
CURRENT = [
    'yearsInLeague', 'invDraftPick', 'draftPickPctOverall',
    'priorTimeToThrow', 'priorPPG2yr',
    'teamSamePosCount', 'newArrivalBestPPR',
    'teamNeutralPassRate', 'teamShotgunRate', 'vegasImpliedSpread', 'vegasWinPct',
    'collegeQBR', 'collegeSosFinalYr', 'ppgTrend', 'teamRosterTurnover',
    'priorInjuryWeeks', 'injuryRecurrence', 'priorKneeInjury',
    'ppgTrend3yr', 'ppgTrend4yr',
]

ZERO_GAIN = ['injuryRecurrence', 'priorKneeInjury']
SUSPECT   = ['teamSamePosCount']

CANDIDATE_ADDS = [
    'priorPPG', 'age',
    'priorPassYards', 'priorPassTDs', 'priorINTs',
    'priorRushYards', 'priorRushTDs', 'priorRushAttempts',
    'priorPassYPA', 'priorTotalTouches',
]


def evaluate(label, feats, qb_train, cfg, base_mae=None):
    e = loso_eval(qb_train, feats, cfg)
    d = (e['mae'] - base_mae) if base_mae is not None else 0
    marker = ('✓' if d < -0.005 else ('·' if abs(d) <= 0.005 else '✗')) if base_mae else ''
    print(f'  {label:<48} ({len(feats):2d} feats) MAE {e["mae"]:.3f}  ΔMAE {d:>+7.3f}  R² {e["r2"]:.3f}  {marker}')
    return e['mae']


def main():
    print('Loading…')
    rows = load_rows()
    fm = json.load(open('public/data/feature-matrix.json'))
    qb_train = [r for r in rows if r['position'] == 'QB' and r.get('adp', 999) <= 250]
    qb_pred = [r for r in fm['predRows'] if r['position'] == 'QB' and r.get('adp', 999) <= 250]
    cfg = PPG_CONFIG['QB']

    print('\n=== Step 1: drop zero-gain injury features ===')
    base = evaluate('current production', CURRENT, qb_train, cfg)
    no_zero = [f for f in CURRENT if f not in ZERO_GAIN]
    no_zero_mae = evaluate('drop injuryRecurrence + priorKneeInjury', no_zero, qb_train, cfg, base)

    print('\n=== Step 2: investigate teamSamePosCount (44% of gain) ===')
    no_tspc = [f for f in no_zero if f != 'teamSamePosCount']
    no_tspc_mae = evaluate('also drop teamSamePosCount', no_tspc, qb_train, cfg, base)

    # Pick the better of {no_zero, no_tspc} as the cleaned baseline
    cleaned_label, cleaned_feats, cleaned_mae = (
        ('+ no zero-gain, + no teamSamePos', no_tspc, no_tspc_mae)
        if no_tspc_mae < no_zero_mae - 0.005
        else ('+ no zero-gain (kept teamSamePos)', no_zero, no_zero_mae)
    )
    print(f'\nCleaned baseline: "{cleaned_label}" — MAE {cleaned_mae:.3f}')

    print('\n=== Step 3: forward-select raw prior-stat candidates ===')
    print('Baseline = cleaned baseline above; add ONE candidate at a time:\n')
    helps = []
    for cand in CANDIDATE_ADDS:
        if cand in cleaned_feats:
            continue
        feats = cleaned_feats + [cand]
        mae = evaluate(f'+ {cand}', feats, qb_train, cfg, cleaned_mae)
        if mae < cleaned_mae - 0.003:
            helps.append((cand, mae))

    if helps:
        helps.sort(key=lambda t: t[1])
        print(f'\nFeatures that helped (ΔMAE < -0.003 vs cleaned):')
        for c, m in helps:
            print(f'  + {c}: MAE {m:.3f}')

        # Try combining the top winners
        print('\n=== Step 4: combine the top forward-selection winners ===')
        top_adds = [c for c, _ in helps[:5]]
        all_combo = cleaned_feats + top_adds
        evaluate(f'+ all top ({len(top_adds)})', all_combo, qb_train, cfg, cleaned_mae)
        # Also try cumulative greedy
        cum = list(cleaned_feats)
        cum_mae = cleaned_mae
        print('Greedy stepwise (add only if it helps from current):')
        for c, _ in helps:
            test = cum + [c]
            tm = loso_eval(qb_train, test, cfg)['mae']
            if tm < cum_mae - 0.003:
                print(f'    + {c}: MAE {cum_mae:.3f} → {tm:.3f}  ✓ keep')
                cum.append(c)
                cum_mae = tm
            else:
                print(f'    + {c}: MAE {cum_mae:.3f} → {tm:.3f}  ✗ skip')
        print(f'  Greedy final: {len(cum)} features, MAE {cum_mae:.3f}')

        # Train final and show 2026 predictions
        print('\n=== 2026 QB prediction shifts (current vs greedy final) ===')
        m_cur = train_full_model(qb_train, CURRENT, cfg)
        m_new = train_full_model(qb_train, cum, cfg)
        p_cur = predict_2026(m_cur, qb_pred)
        p_new = predict_2026(m_new, qb_pred)
        top12 = sorted(zip(qb_pred, p_cur, p_new), key=lambda t: t[0].get('adp', 999))[:14]
        print(f'  {"player":<22} {"adp":>6} {"current":>9} {"new":>8} {"Δ":>7}')
        for r, pc, pn in top12:
            print(f'  {r["name"]:<22} {r.get("adp", 999):>6.1f} {pc:>9.1f} {pn:>8.1f} {pn-pc:>+7.1f}')
        # Lamar specifically
        for r, pc, pn in zip(qb_pred, p_cur, p_new):
            if r['name'] == 'Lamar Jackson':
                print(f'\n  Lamar Jackson detail: {pc:.1f} → {pn:.1f} ({pn-pc:+.1f})')
        # Spread + mean
        sb = sorted(p_cur.tolist(), reverse=True)[:12]
        sn = sorted(p_new.tolist(), reverse=True)[:12]
        print(f'  Top-12 spread: {sb[0]-sb[-1]:.1f} → {sn[0]-sn[-1]:.1f}')
        print(f'  Top-5 mean:    {sum(sb[:5])/5:.1f} → {sum(sn[:5])/5:.1f}')
        return cum
    else:
        print('\nNo candidates beat -0.003 threshold. Cleaned baseline is the recommendation.')
        return cleaned_feats


if __name__ == '__main__':
    final = main()
    print(f'\nFinal recommended QB feature list ({len(final)} features):')
    for f in final:
        print(f'  {f}')
