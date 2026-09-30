#!/usr/bin/env python3
"""Devy model: what a college player's profile says about his NFL fantasy
future, 0-3 seasons before he is draft eligible.

Target: the mean of his best two PPR points-per-game seasons (6+ games) in
his first four NFL seasons, 0 for a season he did not have; 0 for a player
who was never drafted or never played. So it prices both the chance he makes
it and how good he is when he does.

History: every college QB/RB/WR/TE in CFBD 2005-2025 who was a 3-star+
recruit, was drafted, or produced (500+ scrimmage or 1,500+ passing yards in
a season), in draft classes 2010-2022 (four NFL seasons to measure). Each
player contributes one row per snapshot k = 0..3 (seasons left before the
draft), with features computed only from seasons up to then
(scripts/devy_features.py). The draft class of an undrafted player is his
last college season + 1.

One LightGBM model per position, k as a feature. Validated by leaving one
draft class out at a time, against two baselines (recruit rating alone; the
last season's production alone): Spearman correlation with the outcome
inside each (class, k) group, and how many of each group's top-12 by outcome
the model's top-12 catch.

Writes public/data/devy-model.json (metrics, feature importances) and
public/data/devy-model-scores.json: every current college skill player
(a season in the newest complete CFBD year, or that year's recruit; not
drafted) scored for the next three draft years as of that season's end. The daily rankings build
(scripts/build-devy-rankings.py) reads the scores, so it needs no LightGBM.

Usage: python3 scripts/train_devy_model.py
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from scipy.stats import spearmanr

sys.path.insert(0, str(Path(__file__).parent))
from devy_features import (FEATURES, POSITIONS, load_recruits, load_seasons,  # noqa: E402
                           load_sp, load_talent, norm_name, snapshot)

# The newest COMPLETE college season on disk: the model is trained on whole
# seasons, so a partial in-season file must not be read as one.
_TODAY = datetime.now(timezone.utc)
_DONE = _TODAY.year - 1 if _TODAY.month >= 2 else _TODAY.year - 2
LAST_SEASON = max(y for y in range(2005, _DONE + 1) if Path(f'public/data/cfbd/player-season-{y}.json').exists())
YEARS = range(2005, LAST_SEASON + 1)
CLASSES = range(2010, LAST_SEASON - 2)   # draft classes with four NFL seasons measured
KS = (0, 1, 2, 3)
SCORE_DRAFT_YEARS = tuple(range(LAST_SEASON + 2, LAST_SEASON + 5))
PARAMS = dict(objective='regression', learning_rate=0.03, num_leaves=15, min_data_in_leaf=40,
              feature_fraction=0.8, bagging_fraction=0.8, bagging_freq=1, lambda_l2=5.0, verbose=-1)
ROUNDS = 400
OUT = Path('public/data')


def nfl_outcomes() -> dict:
    """gsis -> {season: ppg} for seasons with 6+ games (REG)."""
    out = defaultdict(dict)
    for y in range(2010, LAST_SEASON + 1):
        p = OUT / f'player_stats_{y}.csv.gz'
        if not p.exists():
            continue
        d = pd.read_csv(p, low_memory=False, usecols=['player_id', 'season', 'week', 'season_type', 'fantasy_points_ppr'])
        d = d[d['season_type'] == 'REG']
        g = d.groupby('player_id').agg(g=('week', 'nunique'), pts=('fantasy_points_ppr', 'sum'))
        for pid, r in g.iterrows():
            if r['g'] >= 6:
                out[pid][y] = r['pts'] / r['g']
    return out


def target(gsis: str | None, draft: int, nfl: dict) -> float:
    if not gsis:
        return 0.0
    ppg = sorted((nfl.get(gsis, {}).get(y, 0.0) for y in range(draft, draft + 4)), reverse=True)
    return float((ppg[0] + ppg[1]) / 2)


def main() -> None:
    print('loading CFBD seasons...')
    seasons = load_seasons(YEARS)
    skill = seasons[seasons['position'].isin(POSITIONS)].copy()
    skill['player_id'] = skill['player_id'].astype(str)
    rec = load_recruits(YEARS)
    rec_by_id = {r['player_id']: r for r in rec.to_dict('records') if r['player_id']}
    talent = load_talent(YEARS)
    sp = load_sp(YEARS)
    nfl = nfl_outcomes()

    dp = pd.read_csv(OUT / 'draft_picks.csv.gz')
    dp = dp[dp['position'].isin(['QB', 'RB', 'WR', 'TE', 'FB'])]
    drafted = defaultdict(list)
    for r in dp.itertuples():
        drafted[norm_name(r.pfr_player_name)].append((int(r.season), int(r.pick), r.gsis_id if isinstance(r.gsis_id, str) else None))

    print('building snapshots...')
    groups = {pid: g for pid, g in skill.groupby('player_id')}
    rows = []
    for pid, g in groups.items():
        pos = g['position'].mode().iloc[0]
        F = int(g['season'].max())
        nm = norm_name(g['player'].iloc[-1])
        # Drafted: same name, drafted one or two years after his last CFBD season.
        cand = [d for d in drafted.get(nm, []) if F + 1 <= d[0] <= F + 2]
        draft, pick, gsis = (min(cand, key=lambda d: d[0]) if cand else (F + 1, None, None))
        if draft not in CLASSES:
            continue
        r = rec_by_id.get(pid)
        big = (g['scrim_yds'].max() >= 500) or (g['pass_yds'].max() >= 1500)
        if not (pick or big or (r and (r.get('stars') or 0) >= 3)):
            continue
        y = target(gsis, draft, nfl)
        for k in KS:
            S = draft - 1 - k
            if S < 2005 or (not (g['season'] <= S).any() and not (r and r.get('rclass') and r['rclass'] <= S + 1)):
                continue
            f = snapshot(g, S, k, r, talent, sp)
            rows.append({'player_id': pid, 'name': g['player'].iloc[-1], 'pos': pos, 'draft': draft,
                         'pick': pick, 'y': y, **f})
    D = pd.DataFrame(rows)
    print(f'{len(D)} snapshots, {D.player_id.nunique()} players, drafted {D.drop_duplicates("player_id").pick.notna().sum()}')

    metrics, models, importance = {}, {}, {}
    for pos in POSITIONS:
        P = D[D['pos'] == pos].reset_index(drop=True)
        oof = np.zeros(len(P))
        for cls in CLASSES:
            tr, te = P['draft'] != cls, P['draft'] == cls
            if not te.any():
                continue
            m = lgb.train(PARAMS, lgb.Dataset(P.loc[tr, FEATURES], P.loc[tr, 'y']), ROUNDS)
            oof[te.values] = m.predict(P.loc[te, FEATURES])
        P['pred'] = oof
        P['base_rating'] = P['rating']
        P['base_prod'] = P['last_pass_yds'] if pos == 'QB' else P['last_scrim_yds']
        res = {}
        for k in KS:
            Q = P[P['k'] == k]
            out = {}
            for col in ('pred', 'base_rating', 'base_prod'):
                rhos, hits = [], []
                for _, G in Q.groupby('draft'):
                    if len(G) < 20 or G['y'].std() == 0:
                        continue
                    rhos.append(spearmanr(G[col], G['y']).statistic)
                    top = set(G.nlargest(12, 'y').index)
                    hits.append(len(set(G.nlargest(12, col).index) & top))
                out[col] = {'spearman': round(float(np.nanmean(rhos)), 3), 'top12Hits': round(float(np.mean(hits)), 2)}
            res[f'k{k}'] = {'n': int(len(Q)), **out}
        metrics[pos] = res
        m = lgb.train(PARAMS, lgb.Dataset(P[FEATURES], P['y']), ROUNDS)
        models[pos] = m
        importance[pos] = dict(sorted(zip(FEATURES, (float(v) for v in m.feature_importance('gain'))), key=lambda x: -x[1])[:10])
        print(pos, json.dumps(res))

    # Score current college players: a season in LAST_SEASON, or that year's
    # recruit with no college stats yet, and not already drafted.
    gone = {norm_name(n) for n in dp.loc[dp['season'] >= LAST_SEASON, 'pfr_player_name']}
    cur_ids = set(skill.loc[skill['season'] == LAST_SEASON, 'player_id'])
    cur_ids |= {pid for pid, r in rec_by_id.items()
                if (r.get('rclass') or 0) == LAST_SEASON and r.get('rpos') in POSITIONS and pid not in groups}
    scores = []
    for pid in cur_ids:
        g = groups.get(pid, skill.iloc[0:0])
        r = rec_by_id.get(pid)
        pos = g['position'].mode().iloc[0] if len(g) else (r or {}).get('rpos')
        if pos not in POSITIONS:
            continue
        name = g['player'].iloc[-1] if len(g) else r['rname']
        if norm_name(name) in gone:
            continue
        team = g['team'].iloc[-1] if len(g) else (r or {}).get('committed')
        byD = {}
        for Dy in SCORE_DRAFT_YEARS:
            k = Dy - 1 - LAST_SEASON
            if k > 3:
                continue
            f = snapshot(g, LAST_SEASON, k, r, talent, sp)
            byD[str(Dy)] = round(float(models[pos].predict(pd.DataFrame([f])[FEATURES])[0]), 3)
        scores.append({'cfbdId': pid, 'name': name, 'nameKey': norm_name(name), 'pos': pos, 'team': team,
                       'recruitClass': (r or {}).get('rclass'), 'stars': (r or {}).get('stars'),
                       'rating': (r or {}).get('rating'),
                       'lastSeason': int(g['season'].max()) if len(g) else None,
                       'score': byD})
    now = datetime.now(timezone.utc).isoformat(timespec='seconds')
    json.dump({'generatedAt': now, 'asOfSeason': LAST_SEASON, 'classes': [CLASSES[0], CLASSES[-1]],
               'target': 'mean of best two PPR PPG seasons (6+ games) in first four NFL seasons; 0 if none',
               'metrics': metrics, 'importance': importance, 'params': PARAMS, 'rounds': ROUNDS,
               'nSnapshots': int(len(D))},
              open(OUT / 'devy-model.json', 'w'), indent=1)
    json.dump({'generatedAt': now, 'asOfSeason': LAST_SEASON,
               'note': 'score[draftYear] = expected mean of best two NFL PPR PPG seasons in the first four, '
                       'for this college player if he enters the draft that year (0 = never matters). '
                       'scripts/train_devy_model.py.',
               'players': sorted(scores, key=lambda s: -max(s['score'].values() or [0]))},
              open(OUT / 'devy-model-scores.json', 'w'))
    print(f'scored {len(scores)} current players')


if __name__ == '__main__':
    main()
