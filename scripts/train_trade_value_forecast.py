#!/usr/bin/env python3
"""Forecast StatHead trade values: short term (1 and 3 months) and long term
(6 months and 1 year).

The approach of scripts/train_ktc_timeseries.py (LightGBM on H-ahead log
returns, momentum + player features, out-of-sample CV against a no-change
baseline) applied to StatHead's own as-of trade values
(scripts/fit-player-values.py). Those values have no look-ahead, so every
training sample uses only what was known at its date, and they span three
seasons where the KTC history held 179 days: horizons can reach a year.

Sample: one per (player, week t) with a value at t and t+H.
Target: log(v(t+H) / v(t)), H in weeks (4, 13, 26, 52).
Features (all as of t):
  momentum   log value, returns over 1/4/12/26 weeks, 12-week volatility,
             distance from and weeks since the 52-week high, position rank
             percentile and its 4-week change
  calendar   week of year (sin / cos): the NFL draft, camps, the season and
             its end move values on a calendar
  player     position, age, years in the league, draft round / pick
  production PPR per game this season and in the last 4 games (games played
             before t), last season's PPG and games (nflverse weekly stats)

Models: per format and horizon, LightGBM median (L1) and 10% / 90% quantile
models, position as a feature. Out-of-sample checks:
  walk-forward   train on weeks whose targets end before a cutoff, test the
                 next 13 weeks; several cutoffs
  player-grouped hold out a fifth of the players
each against the no-change baseline (a random walk), with direction hit rate
on moves past 10% and the 10-90% range's coverage.

Output: public/data/trade-value-forecasts.json (StatHead model output only).

Usage: python3 scripts/train_trade_value_forecast.py [--data=public/data]
"""
from __future__ import annotations

import csv
import gzip
import json
import math
import sys
from bisect import bisect_left
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import lightgbm as lgb
import numpy as np

HORIZONS = {4: '1 month', 13: '3 months', 26: '6 months', 52: '1 year'}
POS = {'QB': 0, 'RB': 1, 'WR': 2, 'TE': 3}
FEATURES = ['logValue', 'ret1', 'ret4', 'ret12', 'ret26', 'vol12', 'fromHigh52', 'weeksSinceHigh52',
            'posRankPct', 'posRankPctDelta4', 'woySin', 'woyCos',
            'pos', 'age', 'yearsInLeague', 'draftRound', 'draftPick',
            'ppgSeason', 'gamesSeason', 'ppgLast4', 'ppgPrevSeason', 'gamesPrevSeason']
BASE = {'feature_fraction': 0.8, 'bagging_fraction': 0.8, 'bagging_freq': 1, 'lambda_l2': 1.0,
        'verbose': -1, 'seed': 7}
# Heavily regularised: weekly samples of one player overlap (a 52-week target
# shares 51 weeks with the next week's), so the effective sample is far
# smaller than the row count. Walk-forward skill on superflex (2026-10-21):
# 31 leaves / 200 per leaf gave 1m +2.6%, 6m +5.1%, 1y -1.7% against no
# change; these give 1m +3.1%, 6m +7.2% and (smaller still) 1y +3.5%, with
# the 10-90% range covering 76-83% (58-75% before).
PARAMS_BY_H = {
    4: ({'learning_rate': 0.03, 'num_leaves': 15, 'min_data_in_leaf': 800}, 200),
    13: ({'learning_rate': 0.03, 'num_leaves': 15, 'min_data_in_leaf': 800}, 200),
    26: ({'learning_rate': 0.03, 'num_leaves': 15, 'min_data_in_leaf': 800}, 200),
    52: ({'learning_rate': 0.03, 'num_leaves': 7, 'min_data_in_leaf': 2000}, 150),
}
_H = [4]   # the horizon being fitted (set by main)
CUTOFFS = 4          # walk-forward folds
TEST_WEEKS = 13      # each fold tests this many weeks after its cutoff
MOVE = math.log(1.10)


def season_of(d: date) -> int:
    """The NFL season a date belongs to: September through February is the
    season that started in September; March through August looks ahead to
    the coming one."""
    return d.year if d.month >= 3 else d.year - 1


def load_production(data: Path):
    """gsis -> sorted [(date the game's week was over, season, ppr)] for REG
    games, and season -> first-season by gsis."""
    week_end = {}
    with gzip.open(data / 'games.csv.gz', 'rt') as fh:
        for r in csv.DictReader(fh):
            if r.get('game_type') != 'REG' or not r.get('gameday'):
                continue
            k = (int(r['season']), int(r['week']))
            d = date.fromisoformat(r['gameday'])
            week_end[k] = max(week_end.get(k, d), d)
    games = defaultdict(list)
    first = {}
    for f in sorted(data.glob('player_stats_20*.csv.gz')):
        with gzip.open(f, 'rt') as fh:
            for r in csv.DictReader(fh):
                if r.get('season_type') != 'REG' or not r.get('player_id'):
                    continue
                s, w = int(r['season']), int(r['week'])
                g = r['player_id']
                first[g] = min(first.get(g, s), s)
                end = week_end.get((s, w))
                if end:
                    games[g].append((end + timedelta(days=1), s, float(r.get('fantasy_points_ppr') or 0)))
    for g in games:
        games[g].sort()
    return games, first


def load_draft(data: Path):
    out = {}
    with gzip.open(data / 'draft_picks.csv.gz', 'rt') as fh:
        for r in csv.DictReader(fh):
            if r.get('gsis_id'):
                out[r['gsis_id']] = (int(r['season']), int(r['round']), int(r['pick']))
    return out


def production_at(gl, t: date):
    """Season-to-date and last-4 PPG, last season's PPG and games, from
    games whose week was over before t."""
    if not gl:
        return [np.nan] * 5
    i = bisect_left(gl, (t, -1, -1.0))
    known = gl[:i]
    s = season_of(t)
    cur = [p for _, ss, p in known if ss == s]
    prev = [p for _, ss, p in known if ss == s - 1]
    last4 = [p for _, _, p in known[-4:]]
    mean = lambda xs: float(np.mean(xs)) if xs else np.nan
    return [mean(cur), float(len(cur)), mean(last4), mean(prev), float(len(prev))]


def build(fmt_hist, players, xw, production, first_season, draft):
    """Per player: weekly as-of series and features at every week. Returns
    rows (one per player-week) and the week dates."""
    series = {}
    for pid, h in fmt_hist.items():
        p = players.get(pid)
        if not p or p.get('pos') not in POS or p.get('idp'):
            continue
        d0 = date.fromisoformat(h['from'])
        series[pid] = (d0, np.log(np.array(h['v'], dtype=float)))
    if not series:
        return [], []
    start = min(d0 for d0, _ in series.values())
    end = max(d0 + timedelta(weeks=len(v) - 1) for d0, v in series.values())
    n = (end - start).days // 7 + 1
    grid = np.full((len(series), n), np.nan)
    pids = list(series)
    for i, pid in enumerate(pids):
        d0, v = series[pid]
        k = (d0 - start).days // 7
        grid[i, k:k + len(v)] = v
    pos = np.array([POS[players[p]['pos']] for p in pids])
    # Position rank percentile each week (0 = the position's top value).
    rank_pct = np.full_like(grid, np.nan)
    for c in range(len(POS)):
        rows = np.where(pos == c)[0]
        sub = grid[rows]
        for k in range(n):
            col = sub[:, k]
            ok = ~np.isnan(col)
            if ok.sum() > 1:
                order = (-col[ok]).argsort().argsort()
                tmp = np.full(len(rows), np.nan)
                tmp[ok] = order / (ok.sum() - 1)
                rank_pct[rows, k] = tmp
    out = []
    for i, pid in enumerate(pids):
        p = players[pid]
        x = xw.get(pid, {})
        gsis = x.get('gsis')
        birth = x.get('birth')
        dr = draft.get(gsis) if gsis else None
        gl = production.get(gsis) if gsis else None
        v = grid[i]
        for k in range(n):
            if np.isnan(v[k]):
                continue
            t = start + timedelta(weeks=k, days=6)   # the week's value includes trades through its last day
            lag = lambda m: v[k] - v[k - m] if k >= m and not np.isnan(v[k - m]) else np.nan
            past = v[max(0, k - 12):k + 1]
            steps = np.diff(past[~np.isnan(past)])
            w52 = v[max(0, k - 51):k + 1]
            hi = np.nanmax(w52)
            s = season_of(t)
            woy = t.isocalendar()[1]
            f = {
                'logValue': v[k], 'ret1': lag(1), 'ret4': lag(4), 'ret12': lag(12), 'ret26': lag(26),
                'vol12': float(np.std(steps, ddof=1)) if len(steps) >= 4 else np.nan,
                'fromHigh52': v[k] - hi, 'weeksSinceHigh52': float(len(w52) - 1 - np.nanargmax(w52)),
                'posRankPct': rank_pct[i, k],
                'posRankPctDelta4': rank_pct[i, k] - rank_pct[i, k - 4] if k >= 4 else np.nan,
                'woySin': math.sin(2 * math.pi * woy / 52), 'woyCos': math.cos(2 * math.pi * woy / 52),
                'pos': float(pos[i]),
                'age': (t - birth).days / 365.25 if birth else np.nan,
                'yearsInLeague': float(s - (dr[0] if dr else first_season.get(gsis, s))) if gsis else np.nan,
                'draftRound': float(dr[1]) if dr else np.nan,
                'draftPick': float(dr[2]) if dr else np.nan,
            }
            f.update(zip(['ppgSeason', 'gamesSeason', 'ppgLast4', 'ppgPrevSeason', 'gamesPrevSeason'],
                         production_at(gl, t)))
            out.append((pid, k, t, [f[name] for name in FEATURES], v))
    return out, start


def dataset(rows, h):
    """(X, y, player ids, week index) for horizon h weeks."""
    X, y, who, wk = [], [], [], []
    for pid, k, t, feats, v in rows:
        if k + h < len(v) and not np.isnan(v[k + h]):
            X.append(feats)
            y.append(v[k + h] - v[k])
            who.append(pid)
            wk.append(k)
    return np.array(X, dtype=float), np.array(y), np.array(who), np.array(wk)


def train(X, y, objective, alpha=None):
    extra, rounds = PARAMS_BY_H[_H[0]]
    params = dict(BASE, **extra, objective=objective, **({'alpha': alpha} if alpha else {}))
    ds = lgb.Dataset(X, y, feature_name=FEATURES, categorical_feature=['pos'], free_raw_data=False)
    return lgb.train(params, ds, num_boost_round=rounds)


def scores(y, pred, lo=None, hi=None):
    big = np.abs(y) > MOVE
    out = {'n': int(len(y)),
           'mae': round(float(np.mean(np.abs(y - pred))), 4),
           'maeNoChange': round(float(np.mean(np.abs(y))), 4),
           'directionHit': round(float(np.mean(np.sign(pred[big]) == np.sign(y[big]))), 3) if big.any() else None,
           'bigMoves': int(big.sum())}
    out['skill'] = round(1 - out['mae'] / out['maeNoChange'], 3) if out['maeNoChange'] else None
    if lo is not None:
        out['coverage80'] = round(float(np.mean((y >= lo) & (y <= hi))), 3)
    return out


def evaluate(X, y, who, wk, h):
    """Walk-forward (time) and player-grouped (cross-player) out-of-sample."""
    res = {}
    last = int(wk.max())
    folds = []
    for c in range(CUTOFFS):
        cut = last - TEST_WEEKS * (c + 1) + 1
        tr = wk + h < cut          # targets end before the cutoff: no overlap with the test period
        te = (wk >= cut) & (wk < cut + TEST_WEEKS)
        if tr.sum() >= 2000 and te.sum() >= 200:
            folds.append((tr, te))
    preds = []
    for tr, te in folds:
        m = train(X[tr], y[tr], 'regression_l1')
        q1, q9 = train(X[tr], y[tr], 'quantile', 0.1), train(X[tr], y[tr], 'quantile', 0.9)
        preds.append((y[te], m.predict(X[te]), q1.predict(X[te]), q9.predict(X[te])))
    if preds:
        res['walkForward'] = {**scores(*[np.concatenate(z) for z in zip(*preds)]), 'folds': len(preds)}
    rng = np.random.default_rng(11)
    players = np.unique(who)
    fold_of = dict(zip(players, rng.integers(0, 5, len(players))))
    f = np.array([fold_of[p] for p in who])
    preds = []
    for k in range(5):
        tr, te = f != k, f == k
        m = train(X[tr], y[tr], 'regression_l1')
        q1, q9 = train(X[tr], y[tr], 'quantile', 0.1), train(X[tr], y[tr], 'quantile', 0.9)
        preds.append((y[te], m.predict(X[te]), q1.predict(X[te]), q9.predict(X[te])))
    res['playerGrouped'] = scores(*[np.concatenate(z) for z in zip(*preds)])
    return res


def main() -> None:
    args = dict(a.lstrip('-').split('=', 1) for a in sys.argv[1:] if a.startswith('--') and '=' in a)
    data = Path(args.get('data', 'public/data'))
    hist = json.loads((data / 'player-trade-values-history.json').read_text())
    cur = json.loads((data / 'player-trade-values.json').read_text())
    xw = {}
    for p in json.loads((data / 'player-crosswalk.json').read_text())['players']:
        if p.get('sleeper_id'):
            b = p.get('birth_date')
            xw[str(p['sleeper_id'])] = {'gsis': p.get('gsis_id'),
                                       'birth': date.fromisoformat(b[:10]) if b and len(b) >= 10 else None}
    production, first_season = load_production(data)
    draft = load_draft(data)
    print(f'production for {len(production):,} players, draft rows {len(draft):,}')
    out = {
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'valuesFrom': cur.get('generatedAt'),
        'unit': cur.get('unit'),
        'horizons': [{'weeks': h, 'label': lab} for h, lab in HORIZONS.items()],
        'method': ('LightGBM on H-week log returns of StatHead as-of trade values (no look-ahead): momentum, '
                   'calendar, age, draft capital and production features; median and 10%/90% quantile models. '
                   'Checked out of sample (walk-forward by time, and by held-out players) against a no-change '
                   'baseline. value is the median forecast; lo / hi the 10-90% range.'),
        'formats': {},
    }
    for fmt, fmt_hist in hist['formats'].items():
        players = {p['sleeper_id']: p for p in cur['formats'][fmt]['players']}
        rows, start = build(fmt_hist, players, xw, production, first_season, draft)
        if not rows:
            continue
        last_k = max(k for _, k, _, _, _ in rows)
        now = [(pid, feats, v[k]) for pid, k, t, feats, v in rows if k == last_k]
        Xn = np.array([f for _, f, _ in now], dtype=float)
        res = {'asOf': (start + timedelta(weeks=last_k, days=6)).isoformat(), 'metrics': {}, 'importance': {},
               'players': {pid: {'value': round(float(np.exp(v)) * 100 / 100, 1)} for pid, _, v in now}}
        print(f'{fmt}: {len(rows):,} player-weeks, {len(now)} players now')
        for h, lab in HORIZONS.items():
            _H[0] = h
            X, y, who, wk = dataset(rows, h)
            if len(y) < 3000:
                print(f'  {lab}: {len(y)} samples, skipped')
                continue
            ev = evaluate(X, y, who, wk, h)
            m = train(X, y, 'regression_l1')
            q1, q9 = train(X, y, 'quantile', 0.1), train(X, y, 'quantile', 0.9)
            p50, p10, p90 = m.predict(Xn), q1.predict(Xn), q9.predict(Xn)
            p10, p90 = np.minimum(p10, p50), np.maximum(p90, p50)
            for (pid, _, v), a, b, c in zip(now, p50, p10, p90):
                base = float(np.exp(v))
                res['players'][pid][f'h{h}'] = {'value': round(base * math.exp(a), 1), 'lo': round(base * math.exp(b), 1),
                                                'hi': round(base * math.exp(c), 1), 'change': round(math.exp(a) - 1, 4)}
            imp = m.feature_importance('gain')
            res['importance'][f'h{h}'] = {FEATURES[i]: round(float(imp[i] / imp.sum()), 3)
                                          for i in np.argsort(-imp)[:8]}
            res['metrics'][f'h{h}'] = {'label': lab, 'samples': int(len(y)), **ev}
            wf, pg = ev.get('walkForward', {}), ev['playerGrouped']
            print(f"  {lab:8}: {len(y):,} samples; walk-forward MAE {wf.get('mae')} vs no-change {wf.get('maeNoChange')} "
                  f"(skill {wf.get('skill')}, direction {wf.get('directionHit')}, 80% range {wf.get('coverage80')}); "
                  f"player-held-out skill {pg['skill']}")
        out['formats'][fmt] = res
    dest = data / 'trade-value-forecasts.json'
    dest.write_text(json.dumps(out, indent=1) + '\n')
    print(f'-> {dest}')


if __name__ == '__main__':
    main()
