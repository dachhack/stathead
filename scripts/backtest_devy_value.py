#!/usr/bin/env python3
"""Backtest: does the devy VALUE model predict NFL production, and does the
composite (value blended with the career model) predict it better?

The value model learns what KTC pays for a college profile TODAY; nothing in
it has seen an NFL outcome. So it can be scored, as is, on past draft classes
(2010-2022): every college snapshot the career model trains on (the same
players, seasons and seasons-to-draft k), priced by the value model from the
profile at that point. The career model's scores are its held-out
leave-one-draft-class-out predictions, so neither side has seen the class it
is scored on. The composite is formed exactly as on the board
(scripts/build-devy-rankings.py): market z of log value, career z the normal
score of the career rank, career weight from the career model's skill at
that position and k.

Outcomes: y2 = mean PPR PPG over his first two NFL seasons (a season under 6
games counts 0; undrafted-and-never-played = 0); y = the career model's own
target (best two of the first four); VOR per format (points per game above
12-team replacement, superflex or 1QB).

Evaluation pools: each draft class at each k. "All" = every profile player
in the pool; "top 100" = the 100 the value model prices highest in that pool
(the part of a devy board that gets traded). Metrics: Spearman averaged over
classes; hits = of the top 24 by the score, how many finished top 24 by the
outcome among players with any production (averaged over classes).

Usage: python3 scripts/backtest_devy_value.py [out.json]
  (runs the career model and value model dump hooks; ~4 minutes)
"""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from statistics import NormalDist

import lightgbm as lgb
import numpy as np
import pandas as pd
from scipy.stats import spearmanr

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
from devy_features import (MARKET_FEATURES, POSITIONS, load_recruits, load_seasons, load_sp,  # noqa: E402
                           load_sp_off, load_talent, load_team_games, load_usage, market_features)

OUT = Path('public/data')
FMTS = ('sf', 'oneQB')
TOPN = 100
HITN = 24


def dumps(tmp: Path) -> tuple[pd.DataFrame, pd.DataFrame]:
    env = {**os.environ, 'DEVY_INSEASON': '0'}
    cp, vp = os.environ.get('DEVY_CAREER_PKL'), os.environ.get('DEVY_VALUE_PKL')
    if not cp:
        cp = str(tmp / 'career.pkl')
        subprocess.run([sys.executable, str(HERE / 'train_devy_model.py')], check=True,
                       env={**env, 'DEVY_CAREER_DUMP': cp})
    if not vp:
        vp = str(tmp / 'value.pkl')
        subprocess.run([sys.executable, str(HERE / 'train_devy_value_model.py')], check=True,
                       env={**env, 'DEVY_DUMP': vp})
    return pd.read_pickle(cp), pd.read_pickle(vp)


def fit_value(V: pd.DataFrame):
    """The shipped value model, refit on today's KTC list: P(listed) x ridge value-if-listed."""
    spec = importlib.util.spec_from_file_location('tvm', HERE / 'train_devy_value_model.py')
    tvm = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(tvm)
    from sklearn.linear_model import Ridge
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler
    vm = json.load(open(OUT / 'devy-value-model.json'))
    X = V[MARKET_FEATURES]
    listed = V['listed'].astype(bool).values
    clf = lgb.train(tvm.CLF, lgb.Dataset(X, listed.astype(int)), tvm.CLF_ROUNDS)
    regs = {}
    for f in FMTS:
        L = listed & (V[f] > 0).values
        regs[f] = make_pipeline(StandardScaler(), Ridge(alpha=vm['metrics'][f]['ridgeAlpha'])).fit(
            X[L], np.log(V.loc[L, f].values))
    return clf, regs


def career_weights() -> dict:
    spec = importlib.util.spec_from_file_location('bdr', HERE / 'build-devy-rankings.py')
    bdr = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bdr)
    return bdr.career_weights(json.load(open(OUT / 'devy-model.json')))


def hist_features(C: pd.DataFrame) -> pd.DataFrame:
    years = range(2005, int(C['draft'].max()))
    seasons = load_seasons(years)
    skill = seasons[seasons['position'].isin(POSITIONS)]
    groups = {pid: g for pid, g in skill.groupby('player_id')}
    rec = load_recruits(years)
    rec_by_id = {r['player_id']: r for r in rec.to_dict('records') if r['player_id']}
    talent, sp, sp_off, usage, games = (load_talent(years), load_sp(years), load_sp_off(years),
                                        load_usage(years), load_team_games(years))
    rows = []
    empty = skill.iloc[0:0]
    for r in C.itertuples():
        S = int(r.draft) - 1 - int(r.k)
        rows.append(market_features(groups.get(r.player_id, empty), r.pos, S, int(r.draft), rec_by_id.get(r.player_id),
                                    talent, sp, sp_off, usage, r.player_id, games, None))
    return pd.DataFrame(rows, index=C.index)[MARKET_FEATURES]


def normal_scores(x: np.ndarray) -> np.ndarray:
    nd = NormalDist()
    order = np.argsort(np.argsort(x, kind='stable'), kind='stable')
    return np.array([nd.inv_cdf((i + 0.5) / len(x)) for i in order])


def evaluate(C: pd.DataFrame, scores: dict, target: str, pool: str, by_pos: bool = False) -> dict:
    """Mean over classes (and positions, if by_pos) of Spearman and top-24 hits, per k."""
    out = {}
    for k, K in C.groupby('k'):
        res = {name: {'rho': [], 'hits': []} for name in scores}
        for _, G in K.groupby(['draft'] + (['pos'] if by_pos else [])):
            if pool == 'top':
                G = G.nlargest(TOPN, 'value_sf' if 'sf' in target or target in ('y', 'y2') else 'value_oneQB')
            if len(G) < 20 or G[target].std() == 0:
                continue
            # The outcome's top 24 among players who produced at all: with ties
            # at 0, nlargest would fill the set in pool order (value order).
            top = set(G[G[target] > 0].nlargest(HITN, target).index)
            for name, col in scores.items():
                res[name]['rho'].append(spearmanr(G[col], G[target]).statistic)
                res[name]['hits'].append(len(set(G.nlargest(HITN, col).index) & top))
        out[f'k{k}'] = {name: {'spearman': round(float(np.nanmean(v['rho'])), 3) if v['rho'] else None,
                               'top24Hits': round(float(np.mean(v['hits'])), 2) if v['hits'] else None}
                        for name, v in res.items()}
    return out


ADOPT_GAIN = 0.01
GRID = tuple(round(x * 0.1, 1) for x in range(11))


def fit_weights(C: pd.DataFrame) -> tuple[dict, dict, pd.Series]:
    """Career weight per (position, k), chosen to maximize the within-position
    Spearman (mean of first-two-seasons PPG and the career target) of the
    blend on each class's top 100 by value. Returns the weights fitted on all
    classes, a leave-one-class-out report (each class scored with weights
    chosen on the other twelve) and those held-out weights per row."""
    rho = {}   # (pos, k) -> {class: {w: rho}}
    for (pos, k, d), G in C.groupby(['pos', 'k', 'draft']):
        G = G.nlargest(TOPN, 'value_sf')
        if len(G) < 20 or G['y'].std() == 0:
            continue
        rho.setdefault((pos, int(k)), {})[int(d)] = {
            w: float(np.nanmean([spearmanr((1 - w) * G['mz_pos'] + w * G['cz_pos'], G[t]).statistic
                                 for t in ('y', 'y2')])) for w in GRID}
    weights, loco, w_row = {}, {}, pd.Series(np.nan, index=C.index)
    for (pos, k), by_c in rho.items():
        best = lambda cs: max(GRID, key=lambda w: (np.mean([by_c[c][w] for c in cs]), -w))  # noqa: E731
        weights.setdefault(pos, {})[f'k{k}'] = best(list(by_c))
        held = []
        for c in by_c:
            w = best([x for x in by_c if x != c])
            held.append(by_c[c][w])
            w_row[(C['pos'] == pos) & (C['k'] == k) & (C['draft'] == c)] = w
        shipped = float(C.loc[(C['pos'] == pos) & (C['k'] == k), 'w'].mean())
        near = min(GRID, key=lambda w: abs(w - shipped))
        loco.setdefault(pos, {})[f'k{k}'] = {
            'weight': weights[pos][f'k{k}'], 'shippedWeight': round(shipped, 3),
            'heldOut': round(float(np.mean(held)), 3),
            'shipped': round(float(np.mean([by_c[c][near] for c in by_c])), 3),
            'valueOnly': round(float(np.mean([by_c[c][0.0] for c in by_c])), 3),
            'careerOnly': round(float(np.mean([by_c[c][1.0] for c in by_c])), 3)}
    return weights, loco, w_row


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        C, V = dumps(Path(tmp))
    C = C.reset_index(drop=True)
    print(f'{len(C)} historical snapshots, {C.player_id.nunique()} players, classes {C.draft.min()}-{C.draft.max()}')
    clf, regs = fit_value(V)
    X = hist_features(C)
    bad = X.columns[X.isna().any()].tolist()
    if bad:
        # Older recruiting records miss some fields (height, weight, rating);
        # the value model reads a missing field as 0, as for current players.
        print('filling missing', {c: int(X[c].isna().sum()) for c in bad})
        X = X.fillna(0.0)
    p = clf.predict(X)
    C['p_listed'] = p
    for f in FMTS:
        C[f'value_{f}'] = np.minimum(9999.0, p * np.exp(regs[f].predict(X)))
    W = career_weights()
    C['w'] = [W.get(pos, {}).get(min(max(int(k), min(W[pos])), max(W[pos])), 0.15) for pos, k in zip(C['pos'], C['k'])]
    for f in FMTS:
        mz, cz = np.zeros(len(C)), np.zeros(len(C))
        for _, G in C.groupby(['draft', 'k']):
            lv = np.log(np.maximum(1e-9, G[f'value_{f}'].values))
            mz[G.index] = (lv - lv.mean()) / (lv.std(ddof=1) or 1.0)
            cz[G.index] = normal_scores(G[f'oof_vor_{f}'].values + 1e-6 * G['oof_ppg'].values)
        C[f'mz_{f}'], C[f'cz_{f}'] = mz, cz
        C[f'composite_{f}'] = (1 - C['w']) * mz + C['w'] * cz

    # Within a position the board's composite ranks the career side by VOR
    # (0 for most players); the fair within-position blend uses raw PPG.
    mzp, czp = np.zeros(len(C)), np.zeros(len(C))
    for _, G in C.groupby(['draft', 'k', 'pos']):
        lv = np.log(np.maximum(1e-9, G['value_sf'].values))
        mzp[G.index] = (lv - lv.mean()) / (lv.std(ddof=1) or 1.0) if len(G) > 1 else 0.0
        czp[G.index] = normal_scores(G['oof_ppg'].values)
    C['mz_pos'], C['cz_pos'] = mzp, czp
    C['composite_pos'] = (1 - C['w']) * mzp + C['w'] * czp
    if os.environ.get('DEVY_BACKTEST_DUMP'):
        C.to_pickle(os.environ['DEVY_BACKTEST_DUMP'])

    report = {'nSnapshots': int(len(C)), 'nPlayers': int(C.player_id.nunique()),
              'classes': [int(C.draft.min()), int(C.draft.max())], 'results': {}}
    weights, loco, w_row = fit_weights(C)
    C['w_fit'] = w_row.fillna(C['w'])
    for f in FMTS:
        C[f'compfit_{f}'] = (1 - C['w_fit']) * C[f'mz_{f}'] + C['w_fit'] * C[f'cz_{f}']
    C['compfit_pos'] = (1 - C['w_fit']) * C['mz_pos'] + C['w_fit'] * C['cz_pos']
    report['compositeWeights'] = {
        'weights': weights,
        'rule': ('career weight per position and seasons-to-draft k, fitted on 2010-2022 classes: the blend '
                 'of value-model z and career-rank normal score that best ranks each class\'s top 100 (by value) '
                 'within position on first-two-seasons PPG and best-two-of-first-four PPG'),
        'leaveOneClassOut': loco,
        # Adopted by the board only where the weight chosen on the other
        # classes beat the shipped rule on the held-out class by ADOPT_GAIN;
        # elsewhere the fitted weight is noise around the rule.
        'adopt': {pos: {kk: (v['weight'] if v['heldOut'] - v['shipped'] >= ADOPT_GAIN else None)
                        for kk, v in by_k.items()} for pos, by_k in loco.items()},
        'adoptGain': ADOPT_GAIN}
    for f in FMTS:
        report['results'][f'{f}|top|y_vor_{f}|board|fitted'] = evaluate(
            C, {'shipped': f'composite_{f}', 'fitted_heldout': f'compfit_{f}', 'value': f'value_{f}'}, f'y_vor_{f}', 'top')
    report['results']['pos|top|y2|fitted'] = evaluate(
        C, {'shipped': 'composite_pos', 'fitted_heldout': 'compfit_pos', 'value': 'value_sf'}, 'y2', 'top', by_pos=True)
    for f in FMTS:
        sc = {'value': f'value_{f}', 'career': f'oof_vor_{f}', 'composite': f'composite_{f}'}
        for pool in ('all', 'top'):
            for tgt in (f'y_vor_{f}',):
                report['results'][f'{f}|{pool}|{tgt}|board'] = evaluate(C, sc, tgt, pool)
    # Per position, raw PPG: the first two seasons (y2) and the career target (y).
    for tgt in ('y2', 'y'):
        sc = {'value': 'value_sf', 'career': 'oof_ppg', 'composite': 'composite_pos'}
        for pool in ('all', 'top'):
            report['results'][f'pos|{pool}|{tgt}'] = evaluate(C, sc, tgt, pool, by_pos=True)
    # Weight sweep (descriptive: it looks at outcomes), board-wide VOR.
    sweep = {}
    for f in FMTS:
        for wv in (0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0):
            C['_s'] = (1 - wv) * C[f'mz_{f}'] + wv * C[f'cz_{f}']
            for pool in ('all', 'top'):
                r = evaluate(C, {'s': '_s'}, f'y_vor_{f}', pool)
                sweep.setdefault(f'{f}|{pool}', {})[str(wv)] = {k: v['s'] for k, v in r.items()}
    for wv in (0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0):
        C['_s'] = (1 - wv) * C['mz_pos'] + wv * C['cz_pos']
        for pool in ('all', 'top'):
            r = evaluate(C, {'s': '_s'}, 'y2', pool, by_pos=True)
            sweep.setdefault(f'pos_y2|{pool}', {})[str(wv)] = {k: v['s'] for k, v in r.items()}
    report['weightSweep'] = sweep
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else OUT / 'devy-backtest.json'
    json.dump(report, open(path, 'w'), indent=1)
    for key, r in report['results'].items():
        print(key)
        for k, v in r.items():
            print('  ', k, '  '.join(f'{n}: {x["spearman"]} / {x["top24Hits"]}' for n, x in v.items()))
    print('weights', json.dumps(weights))
    for pos, by_k in loco.items():
        print(' ', pos, by_k)
    for key, r in sweep.items():
        print('sweep', key, {w: round(float(np.mean([v['spearman'] for v in kk.values() if v['spearman'] is not None])), 3)
                             for w, kk in r.items()})


if __name__ == '__main__':
    main()
