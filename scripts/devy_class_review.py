#!/usr/bin/env python3
"""A recent draft class, out of sample: the devy value model alone vs the
career-adjusted composite vs the career model, against what happened in the
NFL.

The career model trains on draft classes with four NFL seasons measured
(through 2022 today), and the value model on today's college players, so the
last two classes (2023, 2024) were seen by neither. Each prospect is scored
from his college profile one and zero seasons before his draft year (k = 1:
end of his second-to-last season; k = 0: end of his final season, just
before the draft), exactly as the board scores a current player: value model
price, career model projection, composite with the board's weights.

Outcome: PPR points per game over his NFL seasons so far (a season under 6
games counts 0; the two-season window for the 2024 class), and the same
above superflex replacement for the whole-board comparison.

Usage: python3 scripts/devy_class_review.py [out.json]
  (runs the career model's dump hook, ~8 minutes; DEVY_CAREER_PKL and
  DEVY_VALUE_PKL reuse existing dumps)
"""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import spearmanr

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import backtest_devy_value as bt  # noqa: E402

OUT = Path('public/data')
TOPN = 100
SHOW = 30


def load_build():
    spec = importlib.util.spec_from_file_location('bdr', HERE / 'build-devy-rankings.py')
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def main() -> None:
    env = {**os.environ, 'DEVY_INSEASON': '0'}
    with tempfile.TemporaryDirectory() as tmp:
        cp = os.environ.get('DEVY_CAREER_PKL') or str(Path(tmp) / 'career.pkl')
        if not os.environ.get('DEVY_CAREER_PKL'):
            subprocess.run([sys.executable, str(HERE / 'train_devy_model.py')], check=True,
                           env={**env, 'DEVY_CAREER_DUMP': cp})
        vp = os.environ.get('DEVY_VALUE_PKL') or str(Path(tmp) / 'value.pkl')
        if not os.environ.get('DEVY_VALUE_PKL'):
            subprocess.run([sys.executable, str(HERE / 'train_devy_value_model.py')], check=True,
                           env={**env, 'DEVY_DUMP': vp})
        Rv, V = pd.read_pickle(cp + '.review'), pd.read_pickle(vp)
    Rv = Rv[Rv['k'] <= 1].reset_index(drop=True)
    clf, regs = bt.fit_value(V)
    X = bt.hist_features(Rv).fillna(0.0)
    p = clf.predict(X)
    for f in bt.FMTS:
        Rv[f'value_{f}'] = np.minimum(9999.0, p * np.exp(regs[f].predict(X)))

    # The board's weights: the career model's skill rule, with the backtest's
    # adopted cells.
    bdr = load_build()
    rule = bdr.career_weights(json.load(open(OUT / 'devy-model.json')))
    adopted = bdr.backtest_weights(json.load(open(OUT / 'devy-backtest.json')))

    def weight(pos: str, k: int) -> float:
        if k in (adopted.get(pos) or {}):
            return adopted[pos][k]
        by_k = rule.get(pos) or {}
        return by_k.get(min(max(k, min(by_k)), max(by_k)), 0.15) if by_k else 0.15
    Rv['w'] = [weight(pos, int(k)) for pos, k in zip(Rv['pos'], Rv['k'])]
    for f in bt.FMTS:
        Rv[f'composite_{f}'] = np.nan
        for _, G in Rv.groupby(['draft', 'k']):
            lv = np.log(np.maximum(1e-9, G[f'value_{f}'].values))
            mz = (lv - lv.mean()) / (lv.std(ddof=1) or 1.0)
            cz = bt.normal_scores(G[f'oof_rank_{f}'].values)
            Rv.loc[G.index, f'composite_{f}'] = (1 - G['w'].values) * mz + G['w'].values * cz

    report = {'classes': sorted(int(d) for d in Rv['draft'].unique()), 'metrics': {}, 'players': {}}
    for (d, k), G in Rv.groupby(['draft', 'k']):
        key = f'{int(d)}|k{int(k)}'
        m = {}
        for pool in ('all', 'top'):
            P = G.nlargest(TOPN, 'value_sf') if pool == 'top' else G
            res = {}
            for name, col, tgt, by_pos in (
                    ('value', 'value_sf', 'y2', True), ('career', 'oof_hit_oneQB', 'y2', True),
                    ('composite', 'composite_sf', 'y2', True),
                    ('value_board', 'value_sf', 'y_vor_sf', False), ('career_board', 'oof_rank_sf', 'y_vor_sf', False),
                    ('composite_board', 'composite_sf', 'y_vor_sf', False)):
                groups = [g for _, g in P.groupby('pos')] if by_pos else [P]
                rhos = [spearmanr(g[col], g[tgt]).statistic for g in groups if len(g) >= 8 and g[tgt].std() > 0]
                prod = P[P[tgt] > 0]
                top = set(prod.nlargest(24, tgt).index)
                res[name] = {'spearman': round(float(np.nanmean(rhos)), 3) if rhos else None,
                             'top24Hits': len(set(P.nlargest(24, col).index) & top) if not by_pos else None}
            m[pool] = res
        report['metrics'][key] = m
        G = G.copy()
        for col, name in (('composite_sf', 'compositeRank'), ('value_sf', 'valueRank'), ('oof_rank_sf', 'careerRank'),
                          ('y2', 'nflRank')):
            G[name] = G[col].rank(ascending=False, method='min').astype(int)
        G['nflPosRank'] = G.groupby('pos')['y2'].rank(ascending=False, method='min').astype(int)
        show = G.nsmallest(SHOW, 'compositeRank')
        # Plus the best NFL producers the composite missed.
        missed = G[(G['nflRank'] <= 24) & (G['y2'] > 0) & (G['compositeRank'] > SHOW)].nsmallest(10, 'nflRank')
        report['players'][key] = [
            {'name': r.name_, 'pos': r.pos, 'pick': None if pd.isna(r.pick) else int(r.pick),
             'compositeRank': int(r.compositeRank), 'valueRank': int(r.valueRank), 'careerRank': int(r.careerRank),
             'value': round(float(r.value_sf)), 'hitPct': round(100 * float(r.oof_hit_oneQB), 1), 'weight': round(float(r.w), 2),
             'nflPPG': round(float(r.y2), 1), 'nflRank': int(r.nflRank), 'nflPosRank': int(r.nflPosRank),
             'missed': bool(missed_flag)}
            for missed_flag, part in ((False, show), (True, missed))
            for r in part.rename(columns={'name': 'name_'}).itertuples()]
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else OUT / 'devy-class-review.json'
    json.dump(report, open(path, 'w'), indent=1)
    for key, m in report['metrics'].items():
        print(key, json.dumps(m))


if __name__ == '__main__':
    main()
