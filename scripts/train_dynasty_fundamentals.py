#!/usr/bin/env python3
"""Dynasty fundamentals model: what the market pays for a stat line.

The forecast models (scripts/train_ktc_timeseries.py) predict how a value
will move, and most of their signal is the value itself and its momentum, so
they barely react when the Value Forecast page's scenario explorer changes
one in-season metric. This model answers the explorer's question directly:

    log(value at t) ~ profile + in-season workload + season phase

with no price features at all. Per-position LightGBM, one row per player
per week over the long KTC history (daily rows are near-duplicates), the
same slow / weekly / phase features the forecast models use, and monotone
constraints so more snaps, targets, carries and yards never lower the fitted
value and injuries, absences and a worse depth-chart slot never raise it.

The explorer applies it relatively: a scenario's implied value is the
player's displayed value × exp(f(scenario) − f(current)). The absolute fit
is never shown (docs/third-party-data-policy.md: it is fitted to a market's
own scale); only the ratio, which is scale-free, reaches the site.

Validation: player-grouped 5-fold CV R² on log value (does profile + usage
explain the value of players the model never saw?), with in-sample R² beside
it. Both are reported in the model file and the Model Docs.

Output: public/data/model-cache-dynasty-fundamentals-v1.json

Usage:
    python3 scripts/train_dynasty_fundamentals.py [--verbose]
"""
import json
import sys
import time
from datetime import timedelta
from pathlib import Path

import numpy as np
from sklearn.metrics import r2_score, mean_absolute_error

sys.path.insert(0, str(Path(__file__).parent))
from train_projection_models import lgb_to_js_gbm, train_lgb_model, sf  # noqa: E402
from train_ktc_timeseries import (  # noqa: E402
    DATA_DIR, POSITIONS, PLAYER_CV_FOLDS, WEEKLY_FEATURE_NAMES,
    load_inputs, load_weekly_caches, slow_feature_names, phase_features,
    compute_weekly_features_for_player, normalize_name,
)

OUTPUT_PATH = DATA_DIR / 'model-cache-dynasty-fundamentals-v1.json'

SAMPLE_EVERY_DAYS = 7   # one row per player per week
MIN_VALUE = 50          # below this the market has stopped pricing the player

PHASE_FEATURE_NAMES = ['daysSinceSeasonStart', 'phaseRegSeason', 'phasePlayoffs', 'phaseOffseason']

# Features that are constant / dead in the caches (see train_ktc_timeseries
# DROP_GLOBAL) or that would let the model see the price.
DROP = {'priorFantasyPPR', 'isRookie', 'hasWeekly', 'depthRankDelta14d'}

# Direction the fitted value may move with each feature: +1 never down as
# the feature rises, -1 never up. Everything else is unconstrained.
MONOTONE = {
    'snapPctLast4': 1, 'snapPctSeason': 1,
    'targetsLast4': 1, 'targetsSeason': 1,
    'carriesLast4': 1, 'carriesSeason': 1,
    'rushRecYardsLast4': 1,
    'passYardsLast4': 1, 'passYardsSeason': 1, 'passTdsLast4': 1, 'passTdsSeason': 1,
    'weeksSinceLastPlayed': -1, 'injuryOut2wk': -1,
    'depthRankLatest': -1,
}

LGB_PARAMS = {
    'objective': 'regression', 'metric': 'l2',
    'learning_rate': 0.05, 'max_depth': 4, 'num_leaves': 15,
    'min_child_samples': 60,     # ~ one player's season of weekly rows
    'subsample': 0.8, 'bagging_freq': 1,
    'colsample_bytree': 0.8,
    'lambda_l2': 2.0,
    'monotone_constraints_method': 'advanced',
    'seed': 42, 'n_jobs': 1,
}
N_ROUNDS = 300


def feature_names_for(pos):
    names = PHASE_FEATURE_NAMES + slow_feature_names(pos) + WEEKLY_FEATURE_NAMES
    return [n for n in names if n not in DROP]


def build_dataset(pos, players, slow_by_pid, seasons):
    """X, y (log 1QB value), pids, feature names: one row per player-week."""
    fn = feature_names_for(pos)
    slow_keys = slow_feature_names(pos)
    rows, ys, pids = [], [], []
    for p in players:
        if p['position'] != pos:
            continue
        slow = slow_by_pid.get(p['pid'], {})
        slow_vec = {k: sf(slow.get(k, 0.0)) for k in slow_keys}
        weekly = compute_weekly_features_for_player(
            f'{normalize_name(p["name"])}::{pos}', seasons)
        dates, vals = p['dates'], p['vals']
        for i in range(0, len(dates), SAMPLE_EVERY_DAYS):
            v = float(vals[i])
            if v < MIN_VALUE:
                continue
            d = dates[i]
            feats = dict(zip(PHASE_FEATURE_NAMES, phase_features(seasons, d)))
            feats.update(slow_vec)
            feats.update(zip(WEEKLY_FEATURE_NAMES, weekly(d)))
            rows.append([feats.get(k, 0.0) for k in fn])
            ys.append(np.log(v))
            pids.append(p['pid'])
    X = np.array(rows, dtype=np.float64)
    X = np.where(np.isfinite(X), X, 0.0)
    return X, np.array(ys), np.array(pids), fn


def params_for(fn):
    return {**LGB_PARAMS, 'monotone_constraints': [MONOTONE.get(f, 0) for f in fn]}


def player_grouped_cv(X, y, pids, fn, verbose_tag=None):
    uniq = np.unique(pids)
    rng = np.random.RandomState(42)
    rng.shuffle(uniq)
    folds = np.array_split(uniq, PLAYER_CV_FOLDS)
    preds, actual = [], []
    for k, held in enumerate(folds):
        te = np.isin(pids, held)
        tr = ~te
        if tr.sum() < 200 or te.sum() < 20:
            continue
        booster = train_lgb_model(X[tr], y[tr], fn, params_for(fn), N_ROUNDS)
        p = booster.predict(X[te])
        preds.extend(p.tolist())
        actual.extend(y[te].tolist())
        if verbose_tag:
            print(f'      [{verbose_tag}] fold {k}: n_te={te.sum()} players={len(held)} '
                  f'R²={r2_score(y[te], p):+.3f}')
    preds, actual = np.array(preds), np.array(actual)
    resid = actual - preds
    return (float(r2_score(actual, preds)), float(mean_absolute_error(actual, preds)),
            float(resid.std()), len(preds))


def main():
    verbose = '--verbose' in sys.argv or '-v' in sys.argv
    t0 = time.time()
    players, slow_by_pid, date_grid = load_inputs()
    seasons = load_weekly_caches()
    print(f'{len(players)} players, {date_grid[0]} → {date_grid[-1]} ({time.time() - t0:.1f}s)')

    out = {'models': {}, 'metadata': {
        'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'schemaVersion': 1,
        'target': 'log(1QB value); the explorer uses exp(f(scenario) - f(current)) as a ratio on the displayed value',
        'ktcHistory': {'from': date_grid[0].isoformat(), 'to': date_grid[-1].isoformat(),
                       'days': len(date_grid)},
        'weeklySeasons': [s['season'] for s in seasons],
        'sampleEveryDays': SAMPLE_EVERY_DAYS,
        'lgbParams': LGB_PARAMS, 'nRounds': N_ROUNDS,
        'monotone': MONOTONE,
        'playerGroupedFolds': PLAYER_CV_FOLDS,
    }}
    print()
    print(f'  {"pos":>4} {"rows":>6} {"players":>7} {"pgR²":>7} {"pgMAE":>7} {"inSampR²":>9}')
    for pos in POSITIONS:
        X, y, pids, fn = build_dataset(pos, players, slow_by_pid, seasons)
        if len(y) < 200:
            print(f'  {pos}: n={len(y)} — skipped')
            continue
        pg_r2, pg_mae, resid_std, n_pred = player_grouped_cv(
            X, y, pids, fn, verbose_tag=pos if verbose else None)
        booster = train_lgb_model(X, y, fn, params_for(fn), N_ROUNDS)
        gbm_js = lgb_to_js_gbm(booster, X, y, fn)
        # Which features the full model actually splits on, for the docs.
        imp = dict(zip(fn, booster.feature_importance('gain')))
        total = sum(imp.values()) or 1.0
        out['models'][pos] = {
            'position': pos,
            'gbmModel': gbm_js,
            'featureNames': fn,
            'n': int(len(y)),
            'players': int(len(np.unique(pids))),
            'yMean': float(y.mean()), 'yStd': float(y.std()),
            'cvR2PlayerGrouped': round(pg_r2, 4),
            'cvMaePlayerGrouped': round(pg_mae, 4),
            'cvResidualStd': round(resid_std, 4),
            'cvNPredsPlayerGrouped': int(n_pred),
            'inSampleR2': gbm_js['rSquared'],
            'gainShare': {k: round(v / total, 4) for k, v in
                          sorted(imp.items(), key=lambda kv: -kv[1]) if v > 0},
        }
        print(f'  {pos:>4} {len(y):6d} {len(np.unique(pids)):7d} {pg_r2:+7.3f} {pg_mae:7.3f} '
              f'{gbm_js["rSquared"]:+9.3f}')
        if verbose:
            top = list(out['models'][pos]['gainShare'].items())[:8]
            print('       gain:', ', '.join(f'{k} {v:.0%}' for k, v in top))

    with open(OUTPUT_PATH, 'w') as f:
        json.dump(out, f)
    print(f'\nWrote {OUTPUT_PATH} ({OUTPUT_PATH.stat().st_size / 1e6:.2f} MB, '
          f'{time.time() - t0:.0f}s)')


if __name__ == '__main__':
    main()
