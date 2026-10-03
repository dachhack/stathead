#!/usr/bin/env python3
"""Devy model: what a college player's profile says about his NFL fantasy
future, 0-3 seasons before he is draft eligible.

Target: HIT, the chance of at least one fantasy-starter season in his first
four NFL seasons: a season (6+ games) above replacement-level PPR points per
game for a 12-team league (the first non-starter: 1QB QB13 / RB30 / WR42 /
TE13; superflex / 2QB moves the QB line to QB25), per format. RB/WR/TE share
one hit model. (Until 2026-10-03 the target was the expected mean of his best
two PPG seasons with 0 for non-NFL players: 89-93% zeros, so the numbers read
as PPG but were mostly probability, e.g. a top QB prospect at 3.0. Held out,
P(hit) ranks NFL value above replacement better than that regression in all
20 position x distance x format cells, and multiplying in the expected value
if he hits added nothing; how good a hit is was not predictable beyond the
position's typical range, so that range ships as a position-level number:
hitPPG.)

DRAFT: the chance he is drafted on Day 1 (round 1), Day 2 (rounds 2-3),
Day 3 (rounds 4-7) or not at all, per position. Finer splits (by round, or
early / mid / late within a round) were tested and do not validate: by round
loses to the base rate from one season out, by third of a round everywhere.

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
from sklearn.metrics import roc_auc_score

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


BLEND_GRID = (0.0, 0.25, 0.5, 0.75, 1.0)


def inseason_weight(v: dict) -> float:
    """Live weight on the season-to-date projection at one (pos, k'): the
    best held-out option at that cell. The blend's weight where the blend
    beats both last season's profile and the season to date alone; 1 where
    the season to date alone is best; else 0 (last season's profile)."""
    prev, ins, blend = v.get('prev'), v.get('inseason'), v.get('blend')
    if prev is None or ins is None:
        return 0.0
    if blend is not None and blend > max(prev, ins):
        return float(v.get('weight') or 0.0)
    return 1.0 if ins > prev else 0.0


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
        # Blend: (1 - a) x prev + a x inseason. a is chosen on the other
        # classes and scored on the held-out one; 'weight' is the choice on
        # every class, used live only where the held-out blend beats prev.
        classes = [d for d, G in J.groupby('draft') if len(G) >= 20 and G['y'].std() > 0]

        def rho_at(a, ds):
            return float(np.nanmean([spearmanr((1 - a) * G['prev'] + a * G['inseason'], G['y']).statistic
                                     for d, G in J.groupby('draft') if d in ds])) if ds else float('nan')
        held = []
        for d in classes:
            a = max(BLEND_GRID, key=lambda a: rho_at(a, [c for c in classes if c != d]))
            held.append(rho_at(a, [d]))
        if held:
            res['blend'] = round(float(np.nanmean(held)), 3)
            res['weight'] = max(BLEND_GRID, key=lambda a: rho_at(a, classes))
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


# Calibration of the hit chance. Held out, the raw classifiers' LEVEL is off
# by competition (production comes easier against weak schedules; hit chances
# ran low on most bands) and the top end is a little overconfident. So per
# position: a logistic in the raw log-odds plus an offset per competition band
# (Platt scaling with band terms), fitted on out-of-fold predictions; the slope
# pulls overconfident predictions in and the offsets fix the level by band.
# (A multiplicative factor per band, as used for the PPG target until
# 2026-10-03, broke at the top: x1.4 on 0.7 is 0.98, and held out WRs called
# 98% hit 62% of the time.) DEVY_CAREER_CAL=0 turns it off.
CAL_C = 10.0
CAL_BANDS = ('nonFBS', 'SP<-5', 'SP-5..5', 'SP5..15', 'SP15+')
CAL_TARGETS = ('hit_oneQB', 'hit_sf')


def comp_band(fbs_last: float, sp_last: float) -> str:
    """His team's level in his last season: below FBS, or FBS by SP+."""
    if not fbs_last or fbs_last <= 0:
        return 'nonFBS'
    return 'SP<-5' if sp_last < -5 else 'SP-5..5' if sp_last < 5 else 'SP5..15' if sp_last < 15 else 'SP15+'


def _cal_x(p, bands) -> np.ndarray:
    p = np.clip(np.asarray(p, dtype=float), 1e-5, 1 - 1e-5)
    b = np.asarray(bands)
    return np.column_stack([np.log(p / (1 - p))] + [(b == x).astype(float) for x in CAL_BANDS[1:]])


def fit_calibration(D: pd.DataFrame, col: str = 'raw') -> dict:
    """(target, pos) -> (slope, intercept, {band: offset}): a logistic in the
    raw log-odds with competition-band offsets, fitted on held-out
    predictions (column <col>_<target>)."""
    from sklearn.linear_model import LogisticRegression
    out = {}
    for tname in CAL_TARGETS:
        ycol, pcol = TARGET_COLS[tname], f'{col}_{tname}'
        for pos, G in D.groupby('pos'):
            if tname == 'hit_sf' and pos != 'QB':
                continue
            if G[ycol].nunique() < 2:
                continue
            lr = LogisticRegression(C=CAL_C, max_iter=5000).fit(_cal_x(G[pcol], G['band']), G[ycol])
            c = lr.coef_[0]
            out[(tname, pos)] = (float(c[0]), float(lr.intercept_[0]),
                                 {b: (float(c[i]) if i else 0.0) for i, b in enumerate(CAL_BANDS)})
    return out


def calibrate(cal: dict, tname: str, pos: str, band, p):
    """Calibrated hit chance(s) for raw chance(s) p in competition band(s)."""
    if tname == 'hit_sf' and pos != 'QB':
        tname = 'hit_oneQB'
    m = cal.get((tname, pos)) if cal else None
    if not m:
        return p
    slope, icpt, off = m
    pa = np.clip(np.asarray(p, dtype=float), 1e-5, 1 - 1e-5)
    ba = np.broadcast_to(np.asarray(band, dtype=object), pa.shape)
    z = icpt + slope * np.log(pa / (1 - pa)) + np.array([off.get(b, 0.0) for b in ba.ravel()]).reshape(pa.shape)
    return 1 / (1 + np.exp(-z))


TARGET_COLS = {'hit_oneQB': 'hit_oneQB', 'hit_sf': 'hit_sf'}


def draft_scale_fit(prob: np.ndarray, y: np.ndarray, prior: float = 50.0) -> np.ndarray:
    """Per-class factor: actual count / predicted count, shrunk toward 1."""
    act = np.bincount(y, minlength=prob.shape[1]).astype(float)
    pred = prob.sum(0)
    return (act + prior) / (pred + prior)


def _logit(p):
    p = np.clip(np.asarray(p, dtype=float), 1e-4, 1 - 1e-4)
    return np.log(p / (1 - p))


def r1_fit(p1: np.ndarray, y1: np.ndarray) -> tuple[float, float]:
    """(a, b) for P(round 1) = sigmoid(a + b logit(p1))."""
    from sklearn.linear_model import LogisticRegression
    lr = LogisticRegression(C=1e6, max_iter=5000).fit(_logit(p1).reshape(-1, 1), y1)
    return float(lr.intercept_[0]), float(lr.coef_[0][0])


R1_TOP = 20   # the round-1 ceiling: actual rate of the model's top-N held-out calls


def r1_apply(q: np.ndarray, ab, ceiling: float = 1.0) -> np.ndarray:
    """Recalibrated round-1 share, at most the ceiling; the other days keep
    their proportions."""
    q = np.atleast_2d(np.asarray(q, dtype=float))
    p1 = np.minimum(1.0 / (1.0 + np.exp(-(ab[0] + ab[1] * _logit(q[:, 0])))), ceiling)
    rest = q[:, 1:] * ((1.0 - p1) / np.clip(1.0 - q[:, 0], 1e-9, None))[:, None]
    return np.column_stack([p1, rest])


# Hit models are classifiers; the draft model is 4-class (Day 1 / Day 2 /
# Day 3 / undrafted).
CLF_PARAMS = {**{k: v for k, v in PARAMS.items() if k != 'objective'}, 'objective': 'binary'}
DRAFT_PARAMS = {**{k: v for k, v in PARAMS.items() if k != 'objective'}, 'objective': 'multiclass', 'num_class': 4}
DRAFT_DAYS = ('day1', 'day2', 'day3', 'undrafted')
DAY_OF_ROUND = {1: 0, 2: 1, 3: 1, 4: 2, 5: 2, 6: 2, 7: 2}
# Evaluation outcome for the hit models' ranking metrics (and the composite's
# career weight): the continuous best-two-season PPG, so a model that tells a
# star from a marginal starter gets credit for it.
EVAL_COL = 'y'


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
    round_of = {(int(r.season), int(r.pick)): int(r.round) for r in dp.itertuples()}
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
        # DEVY_DRAFT_REVIEW=1 adds the newest drafted classes (draft outcome
        # only; their hit target is unmeasured) to check the draft outlook
        # out of sample against the last big board.
        review = bool(os.environ.get('DEVY_CAREER_DUMP')) and (
            draft in REVIEW_CLASSES or (bool(os.environ.get('DEVY_DRAFT_REVIEW')) and REVIEW_CLASSES[-1] < draft <= LAST_SEASON + 1))
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
                    'day': DAY_OF_ROUND.get(round_of.get((draft, int(pick))), 3) if pick else 3,
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
    for f in FMTS:
        D[f'hit_{f}'] = (D[f'y_vor_{f}'] > 0).astype(int)
        if DI is not None:
            DI[f'hit_{f}'] = (DI[f'y_vor_{f}'] > 0).astype(int)
    # What a hit looks like, by position and format: best-two-season PPG of the
    # players who hit (one row per player). Not modelled per player: held out,
    # how good a hit is was no more predictable than this range.
    one = D.sort_values('k').drop_duplicates('player_id')
    hit_ppg = {f: {pos: {q: round(float(np.percentile(G.loc[G[f'hit_{f}'] == 1, 'y'], v)), 1)
                         for q, v in (('p25', 25), ('median', 50), ('p75', 75))}
                   for pos, G in one.groupby('pos') if G[f'hit_{f}'].sum() >= 5}
               for f in FMTS}
    hit_rate = {f: {pos: round(float(G[f'hit_{f}'].mean()), 4) for pos, G in one.groupby('pos')} for f in FMTS}
    # What a hit is worth: mean best-two-season points per game above
    # replacement of past hits, by format and position. Across positions the
    # board ranks hit chance x this (the career rank score), so a QB hit in
    # superflex outweighs a TE hit of the same chance; within a position the
    # order is the hit chance's. (On the high-school board, ranking by hit
    # chance alone lost to the raw rating across positions; x hitValue beat it.)
    hit_value = {f: {pos: round(float(G.loc[G[f'hit_{f}'] == 1, f'y_vor_{f}'].mean()), 3)
                     for pos, G in one.groupby('pos') if G[f'hit_{f}'].sum()} for f in FMTS}
    print(f'{len(D)} snapshots, {D.player_id.nunique()} players, drafted {D.drop_duplicates("player_id").pick.notna().sum()}')

    # Targets: hit (a starter season in the first four) per format. Only the
    # QB line differs between 1QB and superflex, so RB/WR/TE share one model.
    TARGETS = {'hit_oneQB': 'hit_oneQB', 'hit_sf': 'hit_sf'}
    metrics, models, importance, replay = {}, {}, {}, {}
    for tname, ycol in TARGETS.items():
        for pos in POSITIONS:
            if tname == 'hit_sf' and pos != 'QB':
                models[(tname, pos)] = models[('hit_oneQB', pos)]
                continue
            P = D[D['pos'] == pos].reset_index(drop=True)
            PI = DI[DI['pos'] == pos].reset_index(drop=True) if DI is not None and tname == 'hit_oneQB' else None
            oof = np.zeros(len(P))
            for cls in CLASSES:
                tr, te = P['draft'] != cls, P['draft'] == cls
                if not te.any():
                    continue
                m = lgb.train(CLF_PARAMS, lgb.Dataset(P.loc[tr, FEATURES], P.loc[tr, ycol]), ROUNDS)
                oof[te.values] = m.predict(P.loc[te, FEATURES])
                if PI is not None:
                    ti = PI['draft'] == cls
                    if ti.any():
                        PI.loc[ti, 'pred_in'] = m.predict(PI.loc[ti, FEATURES])
            P['pred'] = oof
            D.loc[D.index[D['pos'] == pos], f'oof_{tname}'] = oof
            if PI is not None and 'pred_in' in PI:
                replay.setdefault(pos, replay_metrics(P, PI, EVAL_COL))
            P['base_rating'] = P['rating']
            P['base_prod'] = P['last_pass_yds'] if pos == 'QB' else P['last_scrim_yds']
            res = {}
            for k in KS:
                Q = P[P['k'] == k]
                out = {}
                for col in ('pred', 'base_rating', 'base_prod'):
                    rhos, hits, aucs = [], [], []
                    for _, G in Q.groupby('draft'):
                        if len(G) < 20 or G[EVAL_COL].std() == 0:
                            continue
                        rhos.append(spearmanr(G[col], G[EVAL_COL]).statistic)
                        top = set(G.nlargest(12, EVAL_COL).index)
                        hits.append(len(set(G.nlargest(12, col).index) & top))
                        if G[ycol].nunique() > 1:
                            aucs.append(roc_auc_score(G[ycol], G[col]))
                    out[col] = {'spearman': round(float(np.nanmean(rhos)), 3) if rhos else None,
                                'top12Hits': round(float(np.mean(hits)), 2) if hits else None,
                                'auc': round(float(np.mean(aucs)), 3) if aucs else None}
                res[f'k{k}'] = {'n': int(len(Q)), 'hitRate': round(float(Q[ycol].mean()), 4), **out}
            # Calibration: held-out prediction deciles vs the actual hit rate.
            q = pd.qcut(P['pred'].rank(method='first'), 10, labels=False)
            res['calibration'] = [{'decile': int(d), 'pred': round(float(G['pred'].mean()), 3),
                                   'actual': round(float(G[ycol].mean()), 3), 'n': int(len(G))}
                                  for d, G in P.groupby(q)]
            metrics.setdefault(tname, {})[pos] = res
            m = lgb.train(CLF_PARAMS, lgb.Dataset(P[FEATURES], P[ycol]), ROUNDS)
            models[(tname, pos)] = m
            importance.setdefault(tname, {})[pos] = shap_importance(m, P[FEATURES])
            print(tname, pos, json.dumps(res['k1']))

    # Competition calibration (see fit_calibration), validated nested: each
    # class's held-out predictions are calibrated with factors fitted on the
    # other classes' held-out predictions.
    use_cal = os.environ.get('DEVY_CAREER_CAL', '1') != '0'
    D['band'] = [comp_band(a, b) for a, b in zip(D['fbs_last'], D['sp_last'])]
    for tname in CAL_TARGETS:
        D[f'raw_{tname}'] = D[f'oof_{tname}']
        D[f'cal_{tname}'] = np.nan
    for cls in CLASSES:
        c = fit_calibration(D[D['draft'] != cls])
        m = D['draft'] == cls
        for tname in CAL_TARGETS:
            for pos in POSITIONS:
                mp = m & (D['pos'] == pos)
                if mp.any():
                    D.loc[mp, f'cal_{tname}'] = calibrate(c, tname, pos, D.loc[mp, 'band'].values,
                                                          D.loc[mp, f'raw_{tname}'].values)
    cal = fit_calibration(D) if use_cal else {}
    calib = {'bands': list(CAL_BANDS), 'method': 'logistic in raw log-odds + band offsets (per position)',
             'enabled': use_cal,
             'models': {f'{t}|{p}': {'slope': round(a, 3), 'intercept': round(b, 3),
                                     'bandOffsets': {k: round(v, 3) for k, v in o.items()}}
                        for (t, p), (a, b, o) in sorted(fit_calibration(D).items())},
             'heldOut': {}}
    for pos in POSITIONS:
        P = D[D['pos'] == pos]
        by_band = {}
        for band, G in P.groupby('band'):
            raw, cl = G['raw_hit_oneQB'].sum(), G['cal_hit_oneQB'].clip(upper=1).sum()
            by_band[band] = {'n': int(len(G)), 'hits': int(G['hit_oneQB'].sum()),
                             'actualOverRaw': round(float(G['hit_oneQB'].sum() / raw), 3) if raw else None,
                             'actualOverCalibrated': round(float(G['hit_oneQB'].sum() / cl), 3) if cl else None}
        rho = {}
        for col in ('raw_hit_oneQB', 'cal_hit_oneQB'):
            r = [spearmanr(G[col], G[EVAL_COL]).statistic for _, G in P.groupby(['k', 'draft'])
                 if len(G) >= 20 and G[EVAL_COL].std() > 0]
            rho[col] = round(float(np.nanmean(r)), 4)
        # Reliability: predicted vs actual hit rate by predicted-chance bin.
        rel = []
        for col in ('raw_hit_oneQB', 'cal_hit_oneQB'):
            bins = pd.cut(P[col], [0, .02, .05, .1, .2, .3, .5, .7, 1.0001], include_lowest=True)
            rel.append([{'bin': f'{i.left:.2f}-{min(1, i.right):.2f}', 'n': int(len(G)),
                         'predicted': round(float(G[col].mean()), 3), 'actual': round(float(G['hit_oneQB'].mean()), 3)}
                        for i, G in P.groupby(bins, observed=True)])
        calib['heldOut'][pos] = {'byBand': by_band, 'spearmanRaw': rho['raw_hit_oneQB'],
                                 'spearmanCalibrated': rho['cal_hit_oneQB'],
                                 'reliabilityRaw': rel[0], 'reliabilityCalibrated': rel[1]}
        print('calibration', pos, json.dumps(calib['heldOut'][pos]))
    if use_cal:
        for tname in CAL_TARGETS:
            D[f'oof_{tname}'] = D[f'cal_{tname}'].clip(upper=1.0)

    # Draft day (Day 1 / Day 2 / Day 3 / undrafted), per position, held out by
    # class. The class shares are then rescaled to the held-out base rates
    # (fitted on the other classes, nested), since the boosted probabilities
    # run a little low on the rarer classes.
    draft_models, draft_scale, draft_metrics = {}, {}, {}
    for pos in POSITIONS:
        P = D[D['pos'] == pos].reset_index(drop=True)
        prob = np.zeros((len(P), 4))
        for cls in CLASSES:
            tr, te = (P['draft'] != cls).values, (P['draft'] == cls).values
            if te.any():
                prob[te] = lgb.train(DRAFT_PARAMS, lgb.Dataset(P.loc[tr, FEATURES], P.loc[tr, 'day']),
                                     ROUNDS).predict(P.loc[te, FEATURES])
        cal_prob = np.zeros_like(prob)
        for cls in CLASSES:
            te, tr = (P['draft'] == cls).values, (P['draft'] != cls).values
            if te.any():
                sc = draft_scale_fit(prob[tr], P.loc[tr, 'day'].values)
                q = prob[te] * sc
                cal_prob[te] = q / q.sum(1, keepdims=True)
        y = P['day'].values
        base = np.bincount(y, minlength=4) / len(y)
        res = {}
        for k in KS:
            m = (P['k'] == k).values
            if not m.any():
                continue
            yk, pk, ck = y[m], prob[m], cal_prob[m]
            ll = lambda Q: round(float(-np.mean(np.log(np.clip(Q[np.arange(len(yk)), yk], 1e-9, 1)))), 4)  # noqa: E731
            res[f'k{k}'] = {
                'n': int(m.sum()), 'logLoss': ll(ck), 'logLossUncalibrated': ll(pk), 'logLossBaseRate': ll(np.tile(base, (len(yk), 1))),
                'aucDay1': round(float(roc_auc_score(yk == 0, ck[:, 0])), 3) if (yk == 0).any() else None,
                'aucDay1or2': round(float(roc_auc_score(yk <= 1, ck[:, 0] + ck[:, 1])), 3) if (yk <= 1).any() else None,
                'aucDrafted': round(float(roc_auc_score(yk <= 2, 1 - ck[:, 3])), 3) if (yk <= 2).any() else None,
                'meanPredicted': [round(float(v), 4) for v in ck.mean(0)],
                'actual': [round(float(v), 4) for v in np.bincount(yk, minlength=4) / len(yk)]}
        draft_metrics[pos] = res
        draft_models[pos] = lgb.train(DRAFT_PARAMS, lgb.Dataset(P[FEATURES], P['day']), ROUNDS)
        draft_scale[pos] = draft_scale_fit(prob, y)
        D.loc[D.index[D['pos'] == pos], [f'oof_draft_{d}' for d in DRAFT_DAYS]] = cal_prob
        print('draft', pos, json.dumps(res.get('k1')))

    # Round-1 recalibration by distance from the draft, pooled over positions.
    # Held out, the class-share rescaling left the top of round 1 too sure,
    # more so further out (three seasons out, players given 25-50% went round
    # 1 24% of the time): a logistic in log-odds per distance, fitted on the
    # held-out chances, scored leaving each class out. A line in log-odds
    # still leaves the very top too sure (one season out, the 20 highest
    # held-out calls averaged 73% and went round 1 55% of the time), so the
    # chance is also capped at the round-1 rate of the model's top 20
    # held-out calls at that distance.
    r1_cal, r1_ceiling, r1_metrics = {}, {}, {}
    y1_all = (D['day'] == 0).astype(int).values
    for k in KS:
        m = (D['k'] == k).values & D['oof_draft_day1'].notna().values
        if not m.any():
            continue
        Q = D.loc[m, [f'oof_draft_{d}' for d in DRAFT_DAYS]].values
        y1, drafts = y1_all[m], D.loc[m, 'draft'].values
        nested = np.zeros_like(Q)
        for cls in CLASSES:
            te = drafts == cls
            if te.any():
                nested[te] = r1_apply(Q[te], r1_fit(Q[~te, 0], y1[~te]))
        ll = lambda p: round(float(-np.mean(y1 * np.log(np.clip(p, 1e-9, 1)) + (1 - y1) * np.log(np.clip(1 - p, 1e-9, 1)))), 4)  # noqa: E731
        r1_cal[k] = r1_fit(Q[:, 0], y1)
        order = np.argsort(-nested[:, 0])[:R1_TOP]
        ceiling = float(y1[order].mean())
        r1_ceiling[k] = ceiling
        nested = r1_apply(nested, (0.0, 1.0), ceiling)
        top = nested[:, 0] >= 0.5
        r1_metrics[f'k{k}'] = {'n': int(m.sum()), 'logLossBefore': ll(Q[:, 0]), 'logLossAfter': ll(nested[:, 0]),
                               'aucDay1': round(float(roc_auc_score(y1, nested[:, 0])), 3),
                               'top': {'n': int(top.sum()), 'predicted': round(float(nested[top, 0].mean()), 3) if top.any() else None,
                                       'actual': round(float(y1[top].mean()), 3) if top.any() else None},
                               'a': round(r1_cal[k][0], 4), 'b': round(r1_cal[k][1], 4),
                               'ceiling': round(ceiling, 3), 'ceilingTopN': R1_TOP}
        D.loc[m, [f'oof_draft_{d}' for d in DRAFT_DAYS]] = nested
        print('draft round-1 recalibration', f'k{k}', json.dumps(r1_metrics[f'k{k}']))

    if os.environ.get('DEVY_CAREER_DUMP'):
        # Held-out predictions per snapshot, for scripts/backtest_devy_value.py
        # (calibrated, nested, when the calibration is on).
        nq = D['pos'] != 'QB'
        D.loc[nq, 'oof_hit_sf'] = D.loc[nq, 'oof_hit_oneQB']
        D['oof_hit_sf'] = np.maximum(D['oof_hit_sf'], D['oof_hit_oneQB'])   # a 1QB hit is a superflex hit
        for f in FMTS:
            D[f'oof_rank_{f}'] = D[f'oof_hit_{f}'] * D['pos'].map(hit_value[f]).fillna(0.0)
        D.to_pickle(os.environ['DEVY_CAREER_DUMP'])
        if review_rows:
            Rv = pd.DataFrame(review_rows)
            for tname in TARGETS:
                for pos in POSITIONS:
                    m = Rv['pos'] == pos
                    if m.any():
                        Rv.loc[m, f'oof_{tname}'] = calibrate(
                            cal, tname, pos, [comp_band(a, b) for a, b in zip(Rv.loc[m, 'fbs_last'], Rv.loc[m, 'sp_last'])],
                            models[(tname, pos)].predict(Rv.loc[m, FEATURES]))
            for pos in POSITIONS:
                m = (Rv['pos'] == pos).values
                if m.any():
                    q = draft_models[pos].predict(Rv.loc[m, FEATURES]) * draft_scale[pos]
                    q = q / q.sum(1, keepdims=True)
                    for k in KS:
                        mk = Rv.loc[m, 'k'].values == k
                        if mk.any() and k in r1_cal:
                            q[mk] = r1_apply(q[mk], r1_cal[k], r1_ceiling[k])
                    Rv.loc[m, [f'oof_draft_{d}' for d in DRAFT_DAYS]] = q
            Rv.to_pickle(os.environ['DEVY_CAREER_DUMP'] + '.review')
            print('review classes', sorted(Rv['draft'].unique()), len(Rv))
        print('dumped', len(D))
        return

    # In-season: a player's projection blends last season's profile with the
    # season to date, weighted per position and seasons-to-draft by the
    # replay (inseason_weight; 0 = last season's profile alone).
    use_in = {pos: {int(kk[1:]): inseason_weight(v) for kk, v in (replay.get(pos) or {}).items() if kk.startswith('k')}
              for pos in POSITIONS}
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
        hit, drf = {f: {} for f in FMTS}, {}
        as_of = set()
        for Dy in SCORE_DRAFT_YEARS:
            # Weight on the season-to-date projection (see use_in). A player
            # first seen this season has no end-of-last-season profile, so the
            # season to date is all there is.
            a = use_in[pos].get(Dy - 1 - cur['season'], 0.0) if cur else 0.0
            has_prev = bool(len(g)) or bool(r and (r.get('rclass') or 9999) <= LAST_SEASON + 1)
            if cur and gc is not None and not has_prev:
                a = 1.0
            preds = []   # (weight, ppg, {fmt: vor}, as-of label)
            if a < 1.0 and has_prev and 0 <= Dy - 1 - LAST_SEASON <= 3:
                X1 = pd.DataFrame([snapshot(g, LAST_SEASON, Dy - 1 - LAST_SEASON, r, talent, sp, usage, games, pid)])[FEATURES]
                preds.append((1.0 - a, X1, str(LAST_SEASON)))
            if a > 0.0 and cur and 0 <= Dy - 1 - cur['season'] <= 3:
                X1 = pd.DataFrame([snapshot(gall, cur['season'], Dy - 1 - cur['season'], r, talent_c, sp_c, us_c, gm_c,
                                            pid)])[FEATURES]
                preds.append((a, X1, f'{cur["season"]} week {cur["week"]}'))
            if not preds:
                continue
            tot = sum(w for w, _, _ in preds)
            hv, dv = {f: 0.0 for f in FMTS}, np.zeros(4)
            for w, X1, lab in preds:
                band = comp_band(float(X1['fbs_last'].iloc[0]), float(X1['sp_last'].iloc[0]))
                for f in FMTS:
                    hv[f] += w / tot * float(calibrate(cal, f'hit_{f}', pos, band,
                                                       float(models[(f'hit_{f}', pos)].predict(X1)[0])))
                q = draft_models[pos].predict(X1)[0] * draft_scale[pos]
                q = q / q.sum()
                kk = int(X1['k'].iloc[0]) if 'k' in X1 else Dy - 1 - LAST_SEASON
                if kk in r1_cal:
                    q = r1_apply(q, r1_cal[kk], r1_ceiling[kk])[0]
                dv += w / tot * q
                as_of.add(lab)
            if pos == 'QB':   # a 1QB hit (QB13) is a superflex hit (QB25)
                hv['sf'] = max(hv['sf'], hv['oneQB'])
            for f in FMTS:
                hit[f][str(Dy)] = round(hv[f], 4)
            drf[str(Dy)] = [round(float(v), 4) for v in dv]
        if not drf:
            continue
        scores.append({'cfbdId': pid, 'name': name, 'nameKey': norm_name(name), 'pos': pos, 'team': team,
                       'recruitClass': (r or {}).get('rclass'), 'stars': (r or {}).get('stars'),
                       'rating': (r or {}).get('rating'),
                       'lastSeason': int(gall['season'].max()) if len(gall) else None,
                       'asOf': sorted(as_of),
                       'hit': hit, 'draft': drf})
    now = datetime.now(timezone.utc).isoformat(timespec='seconds')
    json.dump({'generatedAt': now, 'asOfSeason': LAST_SEASON, 'classes': [CLASSES[0], CLASSES[-1]],
               'target': 'hit_<fmt>: at least one fantasy-starter season (6+ games, PPR PPG above that format\'s '
                         'replacement level: 12 teams, 1QB QB13/RB30/WR42/TE13, superflex QB25) in his first four '
                         'NFL seasons. draft: Day 1 (round 1) / Day 2 (rounds 2-3) / Day 3 (rounds 4-7) / undrafted. '
                         'Ranking metrics are scored against the mean of his best two PPR PPG seasons (0 if none).',
               'draftDays': list(DRAFT_DAYS), 'draftMetrics': draft_metrics,
               'draftScale': {p: [round(float(v), 4) for v in s] for p, s in draft_scale.items()},
               'draftRound1Calibration': r1_metrics,
               'hitPPG': hit_ppg, 'hitRate': hit_rate, 'hitValue': hit_value,
               'replacementPPG': repl, 'replacementRank': REPL_RANK,
               'metrics': metrics, 'calibration': calib, 'importance': importance, 'params': PARAMS, 'rounds': ROUNDS,
               'nSnapshots': int(len(D)),
               'inSeason': ({'season': cur['season'], 'throughWeek': cur['week'],
                             'usedFor': {pos: {f'k{k}': u for k, u in by_k.items()} for pos, by_k in use_in.items()},
                             'replay': replay, 'estimator': ins['fit']['quality']} if cur else None)},
              open(OUT / 'devy-model.json', 'w'), indent=1)
    json.dump({'generatedAt': now, 'asOfSeason': LAST_SEASON,
               'inSeason': ({'season': cur['season'], 'throughWeek': cur['week'],
                             'usedFor': {pos: {f'k{k}': u for k, u in by_k.items()} for pos, by_k in use_in.items()}}
                            if cur else None),
               'note': 'hit[fmt][draftYear] = chance of at least one fantasy-starter season in his first four NFL '
                       'seasons (above replacement in 1QB (oneQB) or superflex / 2QB (sf) leagues), if he enters '
                       'the draft that year. draft[draftYear] = [Day 1, Day 2, Day 3, undrafted] probabilities. '
                       'hitPPG = what a hit looks like at each position (best-two-season PPG of past hits). '
                       'scripts/train_devy_model.py.',
               'replacementPPG': repl, 'hitPPG': hit_ppg, 'hitRate': hit_rate, 'hitValue': hit_value,
               'draftDays': list(DRAFT_DAYS),
               'players': sorted(scores, key=lambda s: -max(s['hit']['sf'].values() or [0]))},
              open(OUT / 'devy-model-scores.json', 'w'))
    print(f'scored {len(scores)} current players')


if __name__ == '__main__':
    main()
