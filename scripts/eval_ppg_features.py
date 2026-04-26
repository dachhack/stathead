"""
PPG model retrain + head-to-head comparison.

Baseline is the current production feature list (PPG_FEATURE_LISTS in
train_projection_models.py). Candidate is baseline + candidate adds per
position. For each, runs the same LOSO + GBM+Ridge ensemble the
production trainer uses, then reports:

  - LOSO MAE / R² (overall accuracy).
  - LOSO MAE on top-12-ADP only (accuracy where it matters for fantasy).
  - 2026 prediction spread for top-12 per position (ability to separate
    elite from depth — the headline issue with current QB).
  - Per-player prediction shifts (Allen, Lamar, Hurts, etc. — sanity
    that movement aligns with intuition).

Doesn't touch the production pipeline. Pass-by-pass evaluation only.
"""

import sys, json, math
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / 'scripts'))
from train_projection_models import load_rows, sf, train_lgb_model, lgb_to_js_gbm  # type: ignore

import numpy as np
import lightgbm as lgb
from sklearn.linear_model import Ridge
from sklearn.metrics import r2_score, mean_absolute_error
import warnings
warnings.filterwarnings('ignore')

# Production hyperparameters — must match train_projection_models.PPG_CONFIG.
PPG_CONFIG = {
    'QB': {'depth': 3, 'lr': 0.08, 'n_rounds': 100, 'min_leaf': 8,  'gbm_weight': 0.9},
    'RB': {'depth': 3, 'lr': 0.08, 'n_rounds': 150, 'min_leaf': 25, 'gbm_weight': 0.8},
    'WR': {'depth': 3, 'lr': 0.12, 'n_rounds': 200, 'min_leaf': 3,  'gbm_weight': 0.7},
    'TE': {'depth': 3, 'lr': 0.05, 'n_rounds': 150, 'min_leaf': 8,  'gbm_weight': 0.7},
}

# Production baseline — exact copy from PPG_FEATURE_LISTS in
# train_projection_models.py.
BASELINE = {
    'QB': [
        'yearsInLeague', 'invDraftPick', 'draftPickPctOverall',
        'priorTimeToThrow', 'priorPPG2yr',
        'teamSamePosCount', 'newArrivalBestPPR',
        'teamNeutralPassRate', 'teamShotgunRate', 'vegasImpliedSpread', 'vegasWinPct',
        'collegeQBR', 'collegeSosFinalYr', 'ppgTrend', 'teamRosterTurnover',
        'priorInjuryWeeks', 'injuryRecurrence', 'priorKneeInjury',
    ],
    'RB': [
        'age', 'yearsInLeague', 'invDraftPick', 'draftClassDepth', 'vertical', 'bmi',
        'priorRecEPA', 'priorRushEPA', 'priorPPR', 'teamSamePosCount',
        'teammatePriorPPR', 'projPlayerPPR', 'projTargetShare', 'prospectGrade',
        'ppgTrend', 'priorBoomRate',
        'priorWOPR', 'priorAirYardsShare', 'teamQBPassRating',
        'priorPPG2yr',
        'forty', 'nflDraftRound', 'sosAvgSpread',
        'teamWR3PlusOnField',
    ],
    'WR': [
        'age', 'nflDraftRound', 'invDraftPick',
        'draftPickPct', 'draftPickPctOverall', 'broadJump', 'vertical',
        'priorTargetShare', 'priorYACAboveExp', 'priorPPG', 'priorGames',
        'newArrivalBestPPR', 'priorPPGXage', 'qbOwnPPG',
        'priorBoomRate', 'priorBustGameRate', 'teamDomeGames',
        'priorInjuryWeeks', 'injuryRecurrence',
        'priorPPG2yr',
        'teamWRTotalPPR',
        'priorLateSeasonInjWeeks',
    ],
    'TE': [
        'age', 'nflDraftRound', 'nflDraftPick', 'draftClassDepth',
        'weight', 'bench', 'priorYACperRec', 'priorPPG', 'priorGames',
        'heightAdjSpeedScore', 'priorBoomRate',
        'priorAirYardsShare',
        'durabilityStreak',
        'draftPickPct',
        'team21Rate',
        'priorLateSeasonInjWeeks',
    ],
}

# Candidate additions per position. The intent is "give the model the
# raw signal the prediction-row already carries, especially the
# elite-vet-distinguishing features the current set is missing."
CANDIDATES = {
    'QB': [
        # The flag wrt the current model: priorPPG2yr is the only direct
        # prior-perf feature, and it's a 2-year average — dilutes the
        # last-year signal. Add the single-year priorPPG and the raw
        # passing/rushing volumes so the model can grip on rushing-QB
        # upside (Allen, Lamar, Hurts, Daniels).
        'priorPPG', 'age',
        'priorPassYards', 'priorPassTDs',
        'priorRushAttempts', 'priorRushYards', 'priorRushTDs',
        'priorINTs', 'priorPassYPA',
    ],
    'RB': [
        'priorPPG',
        'priorRushAttempts', 'priorRushYards', 'priorRushTDs',
        'priorTargets', 'priorReceptions', 'priorRecYards', 'priorRecTDs',
        'priorTotalTouches', 'priorSnapPct',
    ],
    'WR': [
        'priorTargets', 'priorReceptions', 'priorRecYards', 'priorRecTDs',
        'priorAirYardsShare', 'priorWOPR', 'priorRACR', 'priorYPRR',
        'priorRoutesRun',
    ],
    'TE': [
        'priorTargets', 'priorReceptions', 'priorRecYards', 'priorRecTDs',
        'priorTargetShare', 'priorPPG2yr',
        'priorWOPR', 'priorRACR',
        'qbOwnPPG',
    ],
}


def make_X(rows, keys):
    return np.array([[sf(r['features'].get(k, 0)) for k in keys] for r in rows])


def fit_ridge_normalized(X, y, alpha=15):
    """Standardize features, fit Ridge, return coef/intercept on the
    standardized scale plus the means/stds for prediction."""
    means = X.mean(axis=0)
    stds = X.std(axis=0)
    stds_safe = np.where(stds > 1e-8, stds, 1.0)
    Xs = (X - means) / stds_safe
    target_mean = y.mean()
    target_std = y.std() if y.std() > 0 else 1.0
    ys = (y - target_mean) / target_std
    r = Ridge(alpha=alpha, fit_intercept=False)
    r.fit(Xs, ys)
    return {
        'coef': r.coef_, 'means': means, 'stds': stds_safe,
        'target_mean': target_mean, 'target_std': target_std,
    }


def predict_ridge_normalized(model, X):
    Xs = (X - model['means']) / model['stds']
    return Xs @ model['coef'] * model['target_std'] + model['target_mean']


def loso_eval(rows, feats, cfg):
    """LOSO CV — same protocol as train_ppg_models. Returns dict of metrics."""
    X = make_X(rows, feats)
    y = np.array([sf(r.get('rawPPG', 0)) for r in rows])
    n = len(rows)
    seasons = sorted(set(r['season'] for r in rows))
    loso = np.zeros(n)
    valid = np.zeros(n, dtype=bool)
    lgb_params = {
        'objective': 'regression', 'metric': 'mae',
        'learning_rate': cfg['lr'], 'max_depth': cfg['depth'],
        'min_child_samples': cfg['min_leaf'], 'subsample': 0.8,
        'seed': 42, 'n_jobs': 1, 'verbosity': -1,
    }
    for held in seasons:
        tr = [i for i, r in enumerate(rows) if r['season'] != held]
        te = [i for i, r in enumerate(rows) if r['season'] == held]
        if len(tr) < 10 or not te:
            continue
        ridge_m = fit_ridge_normalized(X[tr], y[tr])
        rp = predict_ridge_normalized(ridge_m, X[te])
        gbm = train_lgb_model(X[tr], y[tr], feats, lgb_params, cfg['n_rounds'])
        gp = gbm.predict(X[te])
        w = cfg['gbm_weight']
        for j, idx in enumerate(te):
            loso[idx] = w * gp[j] + (1 - w) * rp[j]
            valid[idx] = True

    m = valid
    return {
        'n': int(m.sum()),
        'mae': float(mean_absolute_error(y[m], loso[m])),
        'r2': float(r2_score(y[m], loso[m])),
        'loso_pred': loso,
        'y': y,
        'valid': valid,
    }


def top12_metrics(rows, result, position):
    """Filter to top-12 by ADP per season; report MAE and prediction spread."""
    by_season = {}
    for i, r in enumerate(rows):
        if not result['valid'][i]:
            continue
        by_season.setdefault(r['season'], []).append((r['adp'], i))
    pred_top, actual_top = [], []
    for season, arr in by_season.items():
        arr.sort()
        for adp, i in arr[:12]:
            pred_top.append(result['loso_pred'][i])
            actual_top.append(result['y'][i])
    if not pred_top:
        return None
    return {
        'n': len(pred_top),
        'mae': float(mean_absolute_error(actual_top, pred_top)),
        'pred_min': float(np.min(pred_top)),
        'pred_max': float(np.max(pred_top)),
        'pred_spread': float(np.max(pred_top) - np.min(pred_top)),
        'pred_p10': float(np.percentile(pred_top, 10)),
        'pred_p90': float(np.percentile(pred_top, 90)),
    }


def train_full_model(rows, feats, cfg):
    """Train on full data — for scoring 2026 predictions."""
    X = make_X(rows, feats)
    y = np.array([sf(r.get('rawPPG', 0)) for r in rows])
    ridge_m = fit_ridge_normalized(X, y)
    lgb_params = {
        'objective': 'regression', 'metric': 'mae',
        'learning_rate': cfg['lr'], 'max_depth': cfg['depth'],
        'min_child_samples': cfg['min_leaf'], 'subsample': 0.8,
        'seed': 42, 'n_jobs': 1, 'verbosity': -1,
    }
    gbm = train_lgb_model(X, y, feats, lgb_params, cfg['n_rounds'])
    return {'ridge': ridge_m, 'gbm': gbm, 'feats': feats, 'cfg': cfg}


def predict_2026(model, pred_rows):
    feats = model['feats']
    X = np.array([[sf(r['features'].get(k, 0)) for k in feats] for r in pred_rows])
    rp = predict_ridge_normalized(model['ridge'], X)
    gp = model['gbm'].predict(X)
    w = model['cfg']['gbm_weight']
    return w * gp + (1 - w) * rp


def main():
    print('Loading rows…')
    all_rows = load_rows()
    print('Loading 2026 prediction rows from feature-matrix.json…')
    fm = json.load(open('public/data/feature-matrix.json'))
    pred_rows = fm['predRows']

    print('\n' + '=' * 88)
    print('HEAD-TO-HEAD: baseline vs baseline+candidates')
    print('=' * 88)

    summary = []
    for pos in ['QB', 'RB', 'WR', 'TE']:
        cfg = PPG_CONFIG[pos]
        pos_rows = [r for r in all_rows if r['position'] == pos and r.get('adp', 999) <= 250]
        pos_pred_rows = [r for r in pred_rows if r['position'] == pos and r.get('adp', 999) <= 250]
        baseline_feats = BASELINE[pos]
        new_feats = baseline_feats + [f for f in CANDIDATES[pos] if f not in baseline_feats]

        print(f'\n— {pos} (n_train={len(pos_rows)}, n_pred={len(pos_pred_rows)}) —')
        print(f'  baseline features: {len(baseline_feats)}')
        print(f'  candidate adds:    {len(new_feats) - len(baseline_feats)}  ({", ".join(f for f in CANDIDATES[pos] if f not in baseline_feats)})')

        b = loso_eval(pos_rows, baseline_feats, cfg)
        n = loso_eval(pos_rows, new_feats, cfg)
        bt = top12_metrics(pos_rows, b, pos)
        nt = top12_metrics(pos_rows, n, pos)

        print(f'  LOSO    baseline: MAE {b["mae"]:.3f}  R² {b["r2"]:.3f}')
        print(f'          new:      MAE {n["mae"]:.3f}  R² {n["r2"]:.3f}    (Δ MAE {n["mae"]-b["mae"]:+.3f}  Δ R² {n["r2"]-b["r2"]:+.3f})')
        if bt and nt:
            print(f'  Top-12  baseline: MAE {bt["mae"]:.3f}  spread {bt["pred_spread"]:.2f}  p10-p90 {bt["pred_p10"]:.1f}–{bt["pred_p90"]:.1f}')
            print(f'          new:      MAE {nt["mae"]:.3f}  spread {nt["pred_spread"]:.2f}  p10-p90 {nt["pred_p10"]:.1f}–{nt["pred_p90"]:.1f}')

        # Score 2026 with both, compare per-player.
        m_b = train_full_model(pos_rows, baseline_feats, cfg)
        m_n = train_full_model(pos_rows, new_feats, cfg)
        pred_b = predict_2026(m_b, pos_pred_rows)
        pred_n = predict_2026(m_n, pos_pred_rows)

        # Top-12 by ADP for sample comparison
        pred_pairs = sorted(zip(pos_pred_rows, pred_b, pred_n), key=lambda t: t[0].get('adp', 999))[:12]
        print(f'  2026 top-12 predictions:')
        print(f'    {"player":<22} {"adp":>5} {"baseline":>9} {"new":>9} {"Δ":>7}')
        for r, pb, pn in pred_pairs:
            print(f'    {r["name"]:<22} {r.get("adp", 999):>5.1f} {pb:>9.1f} {pn:>9.1f} {pn-pb:>+7.1f}')

        summary.append({
            'pos': pos,
            'baseline_mae': b['mae'], 'new_mae': n['mae'],
            'baseline_r2': b['r2'], 'new_r2': n['r2'],
            'baseline_top12_mae': bt['mae'] if bt else None,
            'new_top12_mae': nt['mae'] if nt else None,
            'baseline_spread': bt['pred_spread'] if bt else None,
            'new_spread': nt['pred_spread'] if nt else None,
        })

    print('\n' + '=' * 88)
    print('SUMMARY')
    print('=' * 88)
    print(f'{"pos":<4} {"MAE":>22} {"R²":>22} {"top12 MAE":>22} {"top12 spread":>22}')
    print(f'{"":<4} {"baseline → new":>22} {"baseline → new":>22} {"baseline → new":>22} {"baseline → new":>22}')
    for s in summary:
        sig_mae = '✓' if s['new_mae'] < s['baseline_mae'] else '·'
        sig_r2 = '✓' if s['new_r2'] > s['baseline_r2'] else '·'
        sig_t = '✓' if (s['new_top12_mae'] or 999) < (s['baseline_top12_mae'] or 999) else '·'
        sig_s = '✓' if (s['new_spread'] or 0) > (s['baseline_spread'] or 0) else '·'
        print(f'{s["pos"]:<4} '
              f'{s["baseline_mae"]:>9.3f} → {s["new_mae"]:>7.3f} {sig_mae} '
              f'{s["baseline_r2"]:>9.3f} → {s["new_r2"]:>7.3f} {sig_r2} '
              f'{s["baseline_top12_mae"]:>9.3f} → {s["new_top12_mae"]:>7.3f} {sig_t} '
              f'{s["baseline_spread"]:>9.2f} → {s["new_spread"]:>7.2f} {sig_s}')


if __name__ == '__main__':
    main()
