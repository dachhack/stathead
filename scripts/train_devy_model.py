#!/usr/bin/env python3
"""Devy model: what a college player's profile says about his NFL fantasy
future, 0-3 seasons before he is draft eligible.

Target: the mean of his best two PPR points-per-game seasons (6+ games) in
his first four NFL seasons, 0 for a season he did not have; 0 for a player
who was never drafted or never played. So it prices both the chance he makes
it and how good he is when he does. Two more targets make it comparable
ACROSS positions, per league format: the same mean of best two seasons in
points per game above replacement (12 teams, the first non-starter: 1QB
QB13 / RB30 / WR42 / TE13; superflex / 2QB moves the QB line to QB25),
a season below replacement counting 0. A 1QB quarterback's points are worth
less than a superflex one's; RB/WR/TE share one VOR model.

History: every college QB/RB/WR/TE in CFBD 2005-2025 who was a 3-star+
recruit or produced (500+ scrimmage or 1,500+ passing yards in a season) --
the profile alone, never whether he was drafted -- in draft classes
2010-2022 (four NFL seasons to measure). Each player contributes one row
per snapshot k = 0..3 (seasons left before the draft), with features
computed only from seasons up to then
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
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from scipy.stats import spearmanr

sys.path.insert(0, str(Path(__file__).parent))
from devy_features import (FEATURES, POSITIONS, current_estimate, derive, estimate_full, inseason_fit,  # noqa: E402
                           inseason_context, load_current, load_games_raw, load_history_cutoff,
                           load_recruits, load_seasons, load_sp, load_talent, load_team_games, load_usage,
                           nfl_departed, norm_name, snapshot, team_schedule)

# The newest COMPLETE college season on disk: the model is trained on whole
# seasons, so a partial in-season file must not be read as one.
_TODAY = datetime.now(timezone.utc)
_DONE = _TODAY.year - 1 if _TODAY.month >= 2 else _TODAY.year - 2
LAST_SEASON = max(y for y in range(2005, _DONE + 1) if Path(f'public/data/cfbd/player-season-{y}.json').exists())
YEARS = range(2005, LAST_SEASON + 1)
CLASSES = range(2010, LAST_SEASON - 2)   # draft classes with four NFL seasons measured
REVIEW_CLASSES = range(LAST_SEASON - 2, LAST_SEASON)   # 1-2 NFL seasons: out of sample, scored only
KS = (0, 1, 2, 3)
SCORE_DRAFT_YEARS = tuple(range(LAST_SEASON + 2, LAST_SEASON + 5))
PARAMS = dict(objective='regression', learning_rate=0.03, num_leaves=15, min_data_in_leaf=40,
              feature_fraction=0.8, bagging_fraction=0.8, bagging_freq=1, lambda_l2=5.0, verbose=-1, seed=7, deterministic=True)
ROUNDS = 400
OUT = Path('public/data')


# Replacement level, 12 teams, 1 QB / 2 RB / 3 WR / 1 TE / 1 FLEX (+1
# superflex): the first non-starter at each position. Superflex moves only the
# QB line (the extra slot is a QB nearly always). Measured, not assumed: the
# median PPR PPG (6+ games) at that rank over the 2016+ NFL seasons.
REPL_RANK = {'oneQB': {'QB': 13, 'RB': 30, 'WR': 42, 'TE': 13},
             'sf': {'QB': 25, 'RB': 30, 'WR': 42, 'TE': 13}}
FMTS = ('oneQB', 'sf')


def nfl_outcomes():
    """gsis -> {season: ppg} for seasons with 6+ games (REG), and the
    replacement-level PPG per format and position."""
    out = defaultdict(dict)
    by_season = defaultdict(lambda: defaultdict(list))
    for y in range(2010, LAST_SEASON + 1):
        p = OUT / f'player_stats_{y}.csv.gz'
        if not p.exists():
            continue
        d = pd.read_csv(p, low_memory=False, usecols=['player_id', 'position', 'season', 'week', 'season_type',
                                                     'fantasy_points_ppr'])
        d = d[d['season_type'] == 'REG']
        g = d.groupby('player_id').agg(g=('week', 'nunique'), pts=('fantasy_points_ppr', 'sum'), pos=('position', 'first'))
        for pid, r in g.iterrows():
            if r['g'] >= 6:
                out[pid][y] = r['pts'] / r['g']
                if y >= 2016:
                    by_season[y][r['pos']].append(r['pts'] / r['g'])
    repl = {}
    for fmt, ranks in REPL_RANK.items():
        repl[fmt] = {}
        for pos, rk in ranks.items():
            vals = [sorted(by_season[y][pos], reverse=True)[rk - 1] for y in by_season if len(by_season[y][pos]) >= rk]
            repl[fmt][pos] = round(float(np.median(vals)), 2)
    return out, repl


def target(gsis: str | None, draft: int, nfl: dict, sub: float = 0.0) -> float:
    """Mean of his best two seasons in his first four NFL seasons: PPR PPG,
    or with sub = replacement level, points per game above replacement (a
    season below it counts 0)."""
    if not gsis:
        return 0.0
    v = sorted((max(0.0, nfl.get(gsis, {}).get(y, 0.0) - sub) if nfl.get(gsis, {}).get(y) is not None else 0.0
                for y in range(draft, draft + 4)), reverse=True)
    return float((v[0] + v[1]) / 2)


POS_GROUP = {'FB': 'RB'}


def match_draft(groups: dict, dp: pd.DataFrame, drafted: dict) -> dict:
    """CFBD player id -> (draft year, pick, gsis) for players drafted one or
    two years after their last college season.

    1. Same name.
    2. Otherwise the same surname, position and school, when exactly one
       unmatched college player claims that pick: CFBD and the draft record
       can carry different first names ("Mar'Keise" Irving at Oregon is the
       Buccaneers' Bucky Irving). School names differ between the sources
       (Ole Miss / Mississippi), so the mapping is learned from the name
       matches."""
    from collections import Counter

    from devy_features import _college_key
    out, team_map = {}, defaultdict(Counter)
    dp_rows = {int(r.pick) * 10000 + int(r.season): r for r in dp.itertuples()}
    for pid, g in groups.items():
        F = int(g['season'].max())
        cand = [d for d in drafted.get(norm_name(g['player'].iloc[-1]), []) if F + 1 <= d[0] <= F + 2]
        if cand:
            d = min(cand, key=lambda d: d[0])
            out[pid] = d
            r = dp_rows.get(d[1] * 10000 + d[0])
            if r is not None:
                team_map[_college_key(g['team'].iloc[-1])][_college_key(str(r.college))] += 1
    colleges = {t: c.most_common(1)[0][0] for t, c in team_map.items()}
    taken = {(d[0], d[1]) for d in out.values()}
    by_key = defaultdict(list)
    for r in dp.itertuples():
        if (int(r.season), int(r.pick)) in taken:
            continue
        sur = norm_name(str(r.pfr_player_name)).split(' ')[-1]
        by_key[(sur, POS_GROUP.get(r.position, r.position), _college_key(str(r.college)))].append(
            (int(r.season), int(r.pick), r.gsis_id if isinstance(r.gsis_id, str) else None))
    claims = defaultdict(list)
    for pid, g in groups.items():
        if pid in out:
            continue
        F = int(g['season'].max())
        nm = norm_name(g['player'].iloc[-1])
        pos = POS_GROUP.get(g['position'].mode().iloc[0], g['position'].mode().iloc[0])
        tk = _college_key(g['team'].iloc[-1])
        cand = [d for d in by_key.get((nm.split(' ')[-1] if nm else '', pos, colleges.get(tk, tk)), [])
                if F + 1 <= d[0] <= F + 2]
        if len(cand) == 1:
            claims[cand[0]].append(pid)
    added = 0
    for d, pids in claims.items():
        if len(pids) == 1:
            out[pids[0]] = d
            added += 1
    print(f'draft matches: {len(out) - added} by name, {added} more by surname + position + school')
    return out


def replay_metrics(P: pd.DataFrame, PI: pd.DataFrame, ycol: str) -> dict:
    """Held-out Spearman (within draft class) on the same players, for k' = 0..2:
    prev = end of the season before (k'+1), inseason = that snapshot plus the
    season-to-date estimate at the cutoff (k'), full = the whole season (k')."""
    out, gains = {}, []
    for kp in (0, 1, 2):
        prev = P[P['k'] == kp + 1].set_index('player_id')
        full = P[P['k'] == kp].set_index('player_id')
        ins = PI[PI['k_from'] == kp + 1].set_index('player_id')
        ids = sorted(set(prev.index) & set(full.index) & set(ins.index))
        if not ids:
            continue
        J = pd.DataFrame({'draft': full.loc[ids, 'draft'], 'y': full.loc[ids, ycol], 'prev': prev.loc[ids, 'pred'],
                          'inseason': ins.loc[ids, 'pred_in'], 'full': full.loc[ids, 'pred']})
        res = {}
        for col in ('prev', 'inseason', 'full'):
            rhos = [spearmanr(G[col], G['y']).statistic for _, G in J.groupby('draft')
                    if len(G) >= 20 and G['y'].std() > 0]
            res[col] = round(float(np.nanmean(rhos)), 3) if rhos else None
        res['n'] = int(len(J))
        out[f'k{kp}'] = res
        if res['prev'] is not None and res['inseason'] is not None:
            gains.append(res['inseason'] - res['prev'])
    out['meanGain'] = round(float(np.mean(gains)), 3) if gains else 0.0
    return out


def shap_importance(model, X: pd.DataFrame) -> dict:
    """Every feature: mean |SHAP| (importance, in target units) and
    direction (Spearman of the feature's value with its SHAP: +1 = higher
    value raises the prediction, -1 = lowers it, near 0 = mixed / nonlinear)."""
    contrib = model.predict(X, pred_contrib=True)[:, :-1]
    out = {}
    for i, f in enumerate(X.columns):
        sv, xv = contrib[:, i], X[f].values
        rho = spearmanr(xv, sv).statistic if np.std(xv) > 0 and np.std(sv) > 0 else 0.0
        out[f] = {'meanAbsShap': round(float(np.mean(np.abs(sv))), 4),
                  'direction': round(float(0.0 if np.isnan(rho) else rho), 3)}
    return dict(sorted(out.items(), key=lambda kv: -kv[1]['meanAbsShap']))


def main() -> None:
    print('loading CFBD seasons...')
    seasons = load_seasons(YEARS)
    skill = seasons[seasons['position'].isin(POSITIONS)].copy()
    skill['player_id'] = skill['player_id'].astype(str)
    rec = load_recruits(YEARS)
    rec_by_id = {r['player_id']: r for r in rec.to_dict('records') if r['player_id']}
    talent = load_talent(YEARS)
    sp = load_sp(YEARS)
    usage, games = load_usage(YEARS), load_team_games(YEARS)
    nfl, repl = nfl_outcomes()
    print('replacement PPG', repl)

    # Season to date (scripts/fetch_cfbd_inseason.py): the season in progress
    # and the same week cutoff for every past season. The cutoff history
    # calibrates the full-season estimate and replays the model at that point
    # of each past season; the live season is scored from its estimate at the
    # positions where the replay beats the end-of-last-season snapshot.
    # DEVY_INSEASON=0 turns it off.
    cur = load_current() if os.environ.get('DEVY_INSEASON', '1') != '0' else None
    hist_week, hist = load_history_cutoff()
    if cur and hist_week != cur['week']:
        print(f'in-season: history cutoff week {hist_week} != current week {cur["week"]}; skipping')
        cur = None
    ins = None
    if cur:
        games_raw = load_games_raw(YEARS)
        fit = inseason_fit(hist_week, hist)
        est = [estimate_full(hist[hist['season'] == y], seasons, team_schedule(games_raw[y], y, hist_week), fit)
               for y in sorted(set(hist['season'])) if y - 1 in set(seasons['season']) and y in games_raw]
        alt = derive(pd.concat(est, ignore_index=True))
        alt = alt[alt['position'].isin(POSITIONS)]
        ins = {'fit': fit, 'alt': {pid: g for pid, g in alt.groupby('player_id')},
               'ctx': {y: inseason_context(y, hist_week, games_raw[y], sp, {}, usage, games)
                       for y in set(alt['season'])}}
        print(f'in-season: {cur["season"]} through week {cur["week"]}; estimator fit on '
              f'{len(set(alt["season"]))} past seasons at the same cutoff')

    dp = pd.read_csv(OUT / 'draft_picks.csv.gz')
    dp = dp[dp['position'].isin(['QB', 'RB', 'WR', 'TE', 'FB'])]
    drafted = defaultdict(list)
    for r in dp.itertuples():
        drafted[norm_name(r.pfr_player_name)].append((int(r.season), int(r.pick), r.gsis_id if isinstance(r.gsis_id, str) else None))

    print('building snapshots...')
    groups = {pid: g for pid, g in skill.groupby('player_id')}
    draft_of = match_draft(groups, dp, drafted)
    rows, ins_rows, review_rows = [], [], []
    for pid, g in groups.items():
        pos = g['position'].mode().iloc[0]
        F = int(g['season'].max())
        draft, pick, gsis = draft_of.get(pid) or (F + 1, None, None)
        # Review classes: drafted too recently for the four-season target, so
        # never trained on; scored by the final model for
        # scripts/devy_class_review.py (only when dumping).
        review = draft in REVIEW_CLASSES and bool(os.environ.get('DEVY_CAREER_DUMP'))
        if draft not in CLASSES and not review:
            continue
        r = rec_by_id.get(pid)
        big = (g['scrim_yds'].max() >= 500) or (g['pass_yds'].max() >= 1500)
        # The population is defined by the college profile ALONE. Admitting
        # every drafted player regardless (as this once did: 82 of 925 got in
        # only by being drafted) selects on the outcome: a low-profile player
        # who made it is in, his undrafted look-alikes are not, and the model
        # turns optimistic about low-profile players.
        if not (big or (r and (r.get('stars') or 0) >= 3)):
            continue
        y = target(gsis, draft, nfl)
        yv = {f: target(gsis, draft, nfl, repl[f][pos]) for f in FMTS}
        for k in KS:
            S = draft - 1 - k
            if S < 2005 or (not (g['season'] <= S).any() and not (r and r.get('rclass') and r['rclass'] <= S + 1)):
                continue
            f = snapshot(g, S, k, r, talent, sp, usage, games, pid)
            meta = {'player_id': pid, 'name': g['player'].iloc[-1], 'pos': pos, 'draft': draft,
                    'pick': pick, 'y': y, 'y_vor_oneQB': yv['oneQB'], 'y_vor_sf': yv['sf'],
                    # First two NFL seasons: mean PPR PPG (a season under 6 games counts 0).
                    'y2': float(np.mean([nfl.get(gsis, {}).get(yy, 0.0) if gsis else 0.0 for yy in (draft, draft + 1)]))}
            if review:
                review_rows.append({**meta, **f})
                continue
            rows.append({**meta, **f})
            # Replay: the same player at week W of season S+1, one season
            # closer to the draft, from the season-to-date estimate.
            Y = S + 1
            if ins and k >= 1 and Y in ins['ctx']:
                a = ins['alt'].get(pid)
                ga = pd.concat([g[g['season'] <= S], a[a['season'] == Y]]) if a is not None else g[g['season'] <= S]
                spY, _, usY, gmY = ins['ctx'][Y]
                ins_rows.append({**meta, 'k_from': k, **snapshot(ga, Y, k - 1, r, talent, spY, usY, gmY, pid)})
    D = pd.DataFrame(rows)
    DI = pd.DataFrame(ins_rows) if ins_rows else None
    print(f'{len(D)} snapshots, {D.player_id.nunique()} players, drafted {D.drop_duplicates("player_id").pick.notna().sum()}')

    # Targets: raw PPG, and points above replacement per format. Only the QB
    # line differs between 1QB and superflex, so RB/WR/TE share one VOR model.
    TARGETS = {'ppg': 'y', 'vor_oneQB': 'y_vor_oneQB', 'vor_sf': 'y_vor_sf'}
    metrics, models, importance, replay = {}, {}, {}, {}
    for tname, ycol in TARGETS.items():
        for pos in POSITIONS:
            if tname == 'vor_sf' and pos != 'QB':
                models[(tname, pos)] = models[('vor_oneQB', pos)]
                continue
            P = D[D['pos'] == pos].reset_index(drop=True)
            PI = DI[DI['pos'] == pos].reset_index(drop=True) if DI is not None and tname == 'ppg' else None
            oof = np.zeros(len(P))
            for cls in CLASSES:
                tr, te = P['draft'] != cls, P['draft'] == cls
                if not te.any():
                    continue
                m = lgb.train(PARAMS, lgb.Dataset(P.loc[tr, FEATURES], P.loc[tr, ycol]), ROUNDS)
                oof[te.values] = m.predict(P.loc[te, FEATURES])
                if PI is not None:
                    ti = PI['draft'] == cls
                    if ti.any():
                        PI.loc[ti, 'pred_in'] = m.predict(PI.loc[ti, FEATURES])
            P['pred'] = oof
            D.loc[D.index[D['pos'] == pos], f'oof_{tname}'] = oof
            if PI is not None and 'pred_in' in PI:
                replay.setdefault(pos, replay_metrics(P, PI, ycol))
            P['base_rating'] = P['rating']
            P['base_prod'] = P['last_pass_yds'] if pos == 'QB' else P['last_scrim_yds']
            res = {}
            for k in KS:
                Q = P[P['k'] == k]
                out = {}
                for col in ('pred', 'base_rating', 'base_prod'):
                    rhos, hits = [], []
                    for _, G in Q.groupby('draft'):
                        if len(G) < 20 or G[ycol].std() == 0:
                            continue
                        rhos.append(spearmanr(G[col], G[ycol]).statistic)
                        top = set(G.nlargest(12, ycol).index)
                        hits.append(len(set(G.nlargest(12, col).index) & top))
                    out[col] = {'spearman': round(float(np.nanmean(rhos)), 3) if rhos else None,
                                'top12Hits': round(float(np.mean(hits)), 2) if hits else None}
                res[f'k{k}'] = {'n': int(len(Q)), **out}
            # Calibration: held-out prediction deciles vs the actual outcome.
            q = pd.qcut(P['pred'].rank(method='first'), 10, labels=False)
            res['calibration'] = [{'decile': int(d), 'pred': round(float(G['pred'].mean()), 3),
                                   'actual': round(float(G[ycol].mean()), 3), 'n': int(len(G))}
                                  for d, G in P.groupby(q)]
            metrics.setdefault(tname, {})[pos] = res
            m = lgb.train(PARAMS, lgb.Dataset(P[FEATURES], P[ycol]), ROUNDS)
            models[(tname, pos)] = m
            importance.setdefault(tname, {})[pos] = shap_importance(m, P[FEATURES])
            print(tname, pos, json.dumps(res['k1']))

    if os.environ.get('DEVY_CAREER_DUMP'):
        # Held-out predictions per snapshot, for scripts/backtest_devy_value.py.
        nq = D['pos'] != 'QB'
        D.loc[nq, 'oof_vor_sf'] = D.loc[nq, 'oof_vor_oneQB']
        D.to_pickle(os.environ['DEVY_CAREER_DUMP'])
        if review_rows:
            Rv = pd.DataFrame(review_rows)
            for tname in TARGETS:
                for pos in POSITIONS:
                    m = Rv['pos'] == pos
                    if m.any():
                        Rv.loc[m, f'oof_{tname}'] = models[(tname, pos)].predict(Rv.loc[m, FEATURES])
            Rv.to_pickle(os.environ['DEVY_CAREER_DUMP'] + '.review')
            print('review classes', sorted(Rv['draft'].unique()), len(Rv))
        print('dumped', len(D))
        return

    # In-season scoring where the replay beats the end-of-last-season
    # snapshot at that position and seasons-to-draft.
    use_in = {pos: {int(kk[1:]): bool(v.get('inseason') is not None and v.get('prev') is not None
                                       and v['inseason'] > v['prev'])
                    for kk, v in (replay.get(pos) or {}).items() if kk.startswith('k')} for pos in POSITIONS}
    if cur:
        Yc = cur['season']
        est_c = derive(current_estimate(cur, seasons, ins['fit']))
        est_c = est_c[est_c['position'].isin(POSITIONS)]
        cur_groups = {pid: g for pid, g in est_c.groupby('player_id')}
        sp_c, _, us_c, gm_c = inseason_context(Yc, cur['week'], cur['games'], sp, {}, usage, games)
        talent_c = {**talent, **cur['talent']}
        for r in load_recruits([Yc]).to_dict('records'):
            if r['player_id'] and r['player_id'] not in rec_by_id:
                rec_by_id[r['player_id']] = r
        print('in-season scoring by position:', use_in)

    # Score current college players: a season in LAST_SEASON (or the season in
    # progress), or a recruit with no college stats yet, and not already drafted.
    gone = nfl_departed(OUT, since=LAST_SEASON)
    cur_ids = set(skill.loc[skill['season'] == LAST_SEASON, 'player_id'])
    cur_ids |= {pid for pid, r in rec_by_id.items()
                if (r.get('rclass') or 0) == LAST_SEASON and r.get('rpos') in POSITIONS and pid not in groups}
    if cur:
        cur_ids |= set(cur_groups)
        cur_ids |= {pid for pid, r in rec_by_id.items()
                    if (r.get('rclass') or 0) == cur['season'] and r.get('rpos') in POSITIONS}
    scores = []
    for pid in sorted(cur_ids):
        g = groups.get(pid, skill.iloc[0:0])
        gc = cur_groups.get(pid) if cur else None
        r = rec_by_id.get(pid)
        gall = pd.concat([g, gc]) if gc is not None else g
        pos = gall['position'].mode().iloc[0] if len(gall) else (r or {}).get('rpos')
        if pos not in POSITIONS:
            continue
        name = gall['player'].iloc[-1] if len(gall) else r['rname']
        team = gall['team'].iloc[-1] if len(gall) else (r or {}).get('committed')
        if gone(name, pos, team):
            continue
        byD, vor = {}, {f: {} for f in FMTS}
        as_of = set()
        for Dy in SCORE_DRAFT_YEARS:
            live = bool(cur) and use_in[pos].get(Dy - 1 - cur['season'], False)
            S0 = cur['season'] if live else LAST_SEASON
            k = Dy - 1 - S0
            if k > 3 or k < 0:
                continue
            as_of.add(f'{S0} week {cur["week"]}' if live else str(LAST_SEASON))
            if live:
                X1 = pd.DataFrame([snapshot(gall, S0, k, r, talent_c, sp_c, us_c, gm_c, pid)])[FEATURES]
            elif not len(g) and not (r and (r.get('rclass') or 9999) <= LAST_SEASON + 1):
                continue   # a player first seen this season, at a position scored at last season's end
            else:
                X1 = pd.DataFrame([snapshot(g, LAST_SEASON, k, r, talent, sp, usage, games, pid)])[FEATURES]
            byD[str(Dy)] = round(float(models[('ppg', pos)].predict(X1)[0]), 3)
            for f in FMTS:
                vor[f][str(Dy)] = round(max(0.0, float(models[(f'vor_{f}', pos)].predict(X1)[0])), 3)
        if not byD:
            continue
        scores.append({'cfbdId': pid, 'name': name, 'nameKey': norm_name(name), 'pos': pos, 'team': team,
                       'recruitClass': (r or {}).get('rclass'), 'stars': (r or {}).get('stars'),
                       'rating': (r or {}).get('rating'),
                       'lastSeason': int(gall['season'].max()) if len(gall) else None,
                       'asOf': sorted(as_of),
                       'score': byD, 'vor': vor})
    now = datetime.now(timezone.utc).isoformat(timespec='seconds')
    json.dump({'generatedAt': now, 'asOfSeason': LAST_SEASON, 'classes': [CLASSES[0], CLASSES[-1]],
               'target': 'mean of best two PPR PPG seasons (6+ games) in first four NFL seasons; 0 if none. '
                         'vor_<fmt>: the same with each season\'s PPG above that format\'s replacement level '
                         '(12 teams; 1QB QB13/RB30/WR42/TE13, superflex QB25), below-replacement seasons 0',
               'replacementPPG': repl, 'replacementRank': REPL_RANK,
               'metrics': metrics, 'importance': importance, 'params': PARAMS, 'rounds': ROUNDS,
               'nSnapshots': int(len(D)),
               'inSeason': ({'season': cur['season'], 'throughWeek': cur['week'],
                             'usedFor': {pos: {f'k{k}': u for k, u in by_k.items()} for pos, by_k in use_in.items()},
                             'replay': replay, 'estimator': ins['fit']['quality']} if cur else None)},
              open(OUT / 'devy-model.json', 'w'), indent=1)
    json.dump({'generatedAt': now, 'asOfSeason': LAST_SEASON,
               'inSeason': ({'season': cur['season'], 'throughWeek': cur['week'],
                             'usedFor': {pos: {f'k{k}': u for k, u in by_k.items()} for pos, by_k in use_in.items()}}
                            if cur else None),
               'note': 'score[draftYear] = expected mean of best two NFL PPR PPG seasons in the first four, '
                       'for this college player if he enters the draft that year (0 = never matters). '
                       'vor[fmt][draftYear] = the same in points per game above replacement for 1QB (oneQB) or '
                       'superflex / 2QB (sf) leagues, comparable across positions. scripts/train_devy_model.py.',
               'replacementPPG': repl,
               'players': sorted(scores, key=lambda s: -max(s['score'].values() or [0]))},
              open(OUT / 'devy-model-scores.json', 'w'))
    print(f'scored {len(scores)} current players')


if __name__ == '__main__':
    main()
