#!/usr/bin/env python3
"""StatHead dynasty player values fitted to real trades, week by week.

Input: the trade database (scripts/build-sleeper-trade-db.py, --lite is enough).
Output (StatHead model output only: values, never a trade, league or manager;
docs/third-party-data-policy.md):
  public/data/player-trade-values.json          current values per format
  public/data/player-trade-values-history.json  weekly history, last three
                                                seasons, players in 100+ trades

MODEL. Every completed two-team trade in a dynasty or keeper league with no
FAAB is read as an even swap. Each side is the sum of its assets' values:
  player     v(player, week), one value per player per week
  pick       v(class, week), the pick classes of scripts/fit-pick-values.py
             (round x seasons ahead x early / mid / late), startup picks out
Values are exp(phi). The fit minimises, over all trades,
  soft-L1( log(side A) - log(side B) )         (lopsided swaps count less)
  + LAMBDA * sum (phi[w] - phi[w-1])^2          (a random walk per asset)
with each league-season's trades capped at LEAGUE_CAP trades' weight. A
player's value moves when trades move it: busy players follow the last days,
thin ones lean on months either side. LAMBDA is picked on held-out leagues.

  scale      100 = a mid 1st in the next rookie draft, that week (the pick is
             the numeraire, so seasonal pick hype moves every player a bit)
  additive   two 50s trade for one 100
  history    smoothed: a past week's value also uses later trades. The newest
             week is the current estimate. (A filtered, as-of-that-day series
             for backtests is a later step.)
  formats    superflex and 1QB fitted separately; TE premium, team count and
             contender / rebuilder context are later steps.

Usage: python3 scripts/fit-player-values.py <dir> [--outdir=public/data]
       [--lambdas=1,3,10,30] [--min-appear=20]
"""
from __future__ import annotations

import json
import sqlite3
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
from scipy import sparse
from scipy.optimize import minimize

from trade_values_common import (N_CELLS, DraftCalendar, StartupFilter, cell, cell_key, standings,
                                 tier_of)

WEEK_MS = 7 * 86400 * 1000
DELTA = 0.5
LEAGUE_CAP = 30
HISTORY_WEEKS = 156   # the history file keeps the last three seasons...
HISTORY_MIN = 100     # ...for players in at least this many trades
REF = cell(1, 0, 'M')
# Defensive players are valued from IDP leagues' trades only: flagged, so a
# general ranking can leave them out.
IDP_POS = {'DL', 'DE', 'DT', 'LB', 'ILB', 'OLB', 'DB', 'CB', 'S', 'FS', 'SS', 'EDGE'}
FILTER = "t.n_sides = 2 AND t.faab_total = 0 AND t.n_players + t.n_picks > 0 AND t.type IN ('dynasty', 'keeper')"


def load(db):
    """Two-team trades as [(sf, lineage, lg, week_ms, side A assets, side B assets)],
    an asset being ('p', sleeper_id) or ('k', pick class)."""
    startup = StartupFilter(db)
    calendar = DraftCalendar(db)
    sides = standings(db, FILTER)
    trades = {}
    for tid, lineage, lg, season, created, sf in db.execute(
            f'SELECT t.id, t.lineage, t.lg, t.season, t.created, t.sf FROM trades t WHERE {FILTER} '
            'AND t.created IS NOT NULL'):
        trades[tid] = [sf, lineage, lg, season, created, defaultdict(list), False]
    dropped = Counter()
    for tid, kind, to, pid, season, rnd, orig, draft in db.execute(
            "SELECT trade_id, kind, to_rid, player_id, pick_season, pick_round, pick_orig_rid, pick_draft "
            "FROM trade_assets WHERE kind IN ('player', 'pick')"):
        t = trades.get(tid)
        if t is None or t[6]:
            continue
        if kind == 'player':
            if not pid:
                t[6] = True
                dropped['no player id'] += 1
                continue
            t[5][to].append(('p', pid))
            continue
        if season is None or rnd is None:
            t[6] = True
            dropped['pick without season'] += 1
            continue
        if startup.is_startup(t[2], t[3], season, rnd, draft):
            t[6] = True
            dropped['startup pick'] += 1
            continue
        ahead = calendar.ahead(t[1], t[4], season)
        if ahead < 0:
            t[6] = True
            dropped['pick already used'] += 1
            continue
        rank, teams = sides.get(tid, {}).get(orig, (None, None))
        t[5][to].append(('k', cell(rnd, ahead, tier_of(rank, teams))))
    out = []
    for tid, (sf, lineage, lg, season, created, to, bad) in trades.items():
        if bad or len(to) != 2:
            continue
        a, b = list(to.values())
        out.append((sf, lineage, lg, created, a, b))
    print(f'  {len(out):,} usable trades; dropped: {dict(dropped)}')
    return out


class Index:
    """Parameter layout: one phi per asset per week of its span."""

    def __init__(self, rows, w0, n_weeks, min_appear):
        # Keep players in min_appear+ trades, then take counts and week spans
        # from the trades that survive (every asset kept). Spans from all
        # trades left weeks with no usable trade at a span's edge, where a
        # value floated free (a kicker with no trade in 8 weeks priced at 92).
        appear = Counter(x for r in rows for x in r[4] + r[5])
        keep = {x for x, n in appear.items() if x[0] == 'k' or n >= min_appear}
        while True:
            kept_rows = [r for r in rows if all(x in keep for x in r[4] + r[5])]
            appear = Counter(x for r in kept_rows for x in r[4] + r[5])
            again = {x for x in keep if x[0] == 'k' or appear[x] >= min_appear}
            if again == keep:
                break
            keep = again
        span = {}
        for _, _, _, created, a, b in kept_rows:
            w = (created - w0) // WEEK_MS
            for asset in a + b:
                lo, hi = span.get(asset, (w, w))
                span[asset] = (min(lo, w), max(hi, w))
        self.keep = keep
        # Pick classes and the numeraire span every week, so the scale is set
        # everywhere and a pick class can be read off for any week.
        for c in range(N_CELLS):
            if ('k', c) in span or c == REF:
                span[('k', c)] = (0, n_weeks - 1)
        self.offset, self.span = {}, {}
        n = 0
        for x in sorted((x for x in span if x in self.keep or x == ('k', REF)), key=str):
            lo, hi = span[x]
            self.offset[x], self.span[x] = n, (lo, hi)
            n += hi - lo + 1
        self.n = n
        self.appear = appear
        self.ref = np.arange(self.offset[('k', REF)], self.offset[('k', REF)] + n_weeks)

    def col(self, asset, w):
        lo, hi = self.span[asset]
        return self.offset[asset] + min(max(w, lo), hi) - lo

    def diffs(self):
        """Sparse first differences within each asset's span."""
        r, c, v = [], [], []
        k = 0
        for x, off in self.offset.items():
            lo, hi = self.span[x]
            for i in range(hi - lo):
                r += [k, k]
                c += [off + i, off + i + 1]
                v += [-1.0, 1.0]
                k += 1
        return sparse.csr_matrix((v, (r, c)), shape=(k, self.n))


def design(rows, idx, w0):
    usable = [r for r in rows if all(x in idx.offset for x in r[4] + r[5])]
    ia, ja, ib, jb = [], [], [], []
    per_lg = Counter(r[2] for r in usable)
    w = np.empty(len(usable))
    for i, (_, _, lg, created, a, b) in enumerate(usable):
        wk = (created - w0) // WEEK_MS
        ia += [i] * len(a)
        ja += [idx.col(x, wk) for x in a]
        ib += [i] * len(b)
        jb += [idx.col(x, wk) for x in b]
        w[i] = min(1.0, LEAGUE_CAP / per_lg[lg])
    A = sparse.csr_matrix((np.ones(len(ia)), (ia, ja)), shape=(len(usable), idx.n))
    B = sparse.csr_matrix((np.ones(len(ib)), (ib, jb)), shape=(len(usable), idx.n))
    return A, B, w, usable


def fit(A, B, w, D, lam, ref, x0=None, maxiter=3000):
    DtD = (D.T @ D).tocsr()

    def f(phi):
        phi = phi.copy()
        phi[ref] = 0.0
        v = np.exp(phi)
        sa, sb = A @ v, B @ v
        r = np.log(sa) - np.log(sb)
        s = np.sqrt(1 + (r / DELTA) ** 2)
        loss = np.sum(w * 2 * DELTA ** 2 * (s - 1))
        dr = w * r / s
        g = v * (A.T @ (dr / sa) - B.T @ (dr / sb))
        Dp = DtD @ phi
        loss += lam * float(phi @ Dp)
        g += 2 * lam * Dp
        g[ref] = 0.0
        return loss, g

    start = x0 if x0 is not None else np.full(A.shape[1], np.log(0.3))
    start[ref] = 0.0
    res = minimize(f, start, jac=True, method='L-BFGS-B', options={'maxiter': maxiter, 'maxcor': 20})
    phi = res.x
    phi[ref] = 0.0
    return phi, res


def holdout_error(phi, A, B):
    v = np.exp(phi)
    return float(np.median(np.abs(np.log(A @ v) - np.log(B @ v))))


def fit_format(rows, names, lambdas, min_appear, seed):
    w0 = min(r[3] for r in rows)
    w0 -= w0 % WEEK_MS
    n_weeks = int((max(r[3] for r in rows) - w0) // WEEK_MS) + 1
    idx = Index(rows, w0, n_weeks, min_appear)
    D = idx.diffs()
    print(f'    {idx.n:,} parameters over {n_weeks} weeks, {sum(1 for x in idx.offset if x[0] == "p"):,} players')

    # Pick LAMBDA on held-out leagues (20%), with a static fit (one value per
    # player for all time) and counting assets as the baselines.
    lins = sorted({r[1] for r in rows})
    rng = np.random.default_rng(seed)
    test = set(rng.choice(lins, max(1, len(lins) // 5), replace=False))
    A_tr, B_tr, w_tr, _ = design([r for r in rows if r[1] not in test], idx, w0)
    A_te, B_te, _, _ = design([r for r in rows if r[1] in test], idx, w0)
    scores = {}
    x0 = None
    for lam in sorted(lambdas, reverse=True):
        phi, res = fit(A_tr, B_tr, w_tr, D, lam, idx.ref, x0)
        x0 = phi
        scores[lam] = holdout_error(phi, A_te, B_te)
        print(f'    lambda {lam:g}: held-out median |log ratio| {scores[lam]:.3f} ({res.nit} iterations)')
    static, _ = fit(A_tr, B_tr, w_tr, D, 1e5, idx.ref, x0)
    count = float(np.median(np.abs(np.log(np.asarray(A_te.sum(axis=1)).ravel())
                                   - np.log(np.asarray(B_te.sum(axis=1)).ravel()))))
    best = min(scores, key=scores.get)

    A, B, w, used = design(rows, idx, w0)
    phi, res = fit(A, B, w, D, best, idx.ref, x0)
    print(f'    final lambda {best:g}: {res.nit} iterations, {len(used):,} trades')

    week_date = lambda k: datetime.fromtimestamp((w0 + k * WEEK_MS) / 1000, timezone.utc).date().isoformat()
    last = n_weeks - 1
    recent = Counter()
    for _, _, _, created, a, b in used:
        if (created - w0) // WEEK_MS > last - 8:
            for x in a + b:
                recent[x] += 1
    players, history = [], {}
    for x, off in idx.offset.items():
        if x[0] != 'p':
            continue
        lo, hi = idx.span[x]
        vals = 100 * np.exp(phi[off:off + hi - lo + 1])
        nm, pos = names.get(x[1], (None, None))
        cur_w = min(last, hi)
        row = {'sleeper_id': x[1], 'name': nm, 'pos': pos, **({'idp': True} if pos in IDP_POS else {}),
               'value': round(float(vals[cur_w - lo]), 1),
               'asOf': week_date(cur_w), 'trades8w': recent[x], 'tradesAll': idx.appear[x]}
        for ago in (4, 12, 52):
            if cur_w - ago >= lo:
                row[f'value{ago}wAgo'] = round(float(vals[cur_w - ago - lo]), 1)
        players.append(row)
        if idx.appear[x] >= HISTORY_MIN and hi > last - HISTORY_WEEKS:
            h0 = max(lo, last - HISTORY_WEEKS + 1)
            history[x[1]] = {'from': week_date(h0), 'v': [round(float(v), 1) for v in vals[h0 - lo:]]}
    players.sort(key=lambda r: -r['value'])
    picks = []
    for c in range(N_CELLS):
        if ('k', c) not in idx.offset:
            continue
        r, a, t = cell_key(c)
        off = idx.offset[('k', c)]
        picks.append({'round': r, 'ahead': a, 'tier': t, 'value': round(float(100 * np.exp(phi[off + last])), 1),
                      'n': idx.appear.get(('k', c), 0)})
    return {
        'trades': len(used), 'weeks': n_weeks, 'from': week_date(0), 'to': week_date(last),
        'lambda': best,
        'holdout': {'trades': A_te.shape[0], 'medianAbsLogRatio': {f'{k:g}': round(v, 3) for k, v in scores.items()},
                    'static': round(holdout_error(static, A_te, B_te), 3), 'countOnly': round(count, 3),
                    'note': 'median |log(side A / side B)| on held-out leagues: per lambda, a static fit (one '
                            'value per player for all time) and counting every asset as 1'},
        'players': players, 'picks': picks,
    }, history


def main() -> None:
    args = dict(a.lstrip('-').split('=', 1) for a in sys.argv[1:] if a.startswith('--') and '=' in a)
    d = Path(next(a for a in sys.argv[1:] if not a.startswith('--')))
    outdir = Path(args.get('outdir', 'public/data'))
    lambdas = [float(x) for x in args.get('lambdas', '1,3,10,30').split(',')]
    min_appear = int(args.get('min-appear', 20))
    db = sqlite3.connect(d / 'sleeper-trades.sqlite')
    # Sleeper's slim player list covers offense only; IDP names come from
    # the crosswalk.
    names = {}
    xw = Path('public/data/player-crosswalk.json')
    if xw.exists():
        for p in json.loads(xw.read_text()).get('players', []):
            if p.get('sleeper_id'):
                names[str(p['sleeper_id'])] = (p.get('display_name'), p.get('position'))
    for pid, n, p in db.execute('SELECT player_id, name, position FROM players'):
        if n:
            names[pid] = (n, p)
    rows = load(db)
    out = {
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'source': 'StatHead fit to completed two-team trades in public Sleeper dynasty and keeper leagues',
        'unit': '100 = a mid 1st in the next rookie draft, the same week; additive (two 50s trade for one 100)',
        'note': ('value: the newest week of a weekly random-walk fit. valueNwAgo: the same fit N weeks back '
                 '(smoothed: it also uses later trades). trades8w / tradesAll: trades the player was in. '
                 'idp: a defensive player, valued from IDP leagues only. '
                 f'Players in fewer than {min_appear} trades are not fitted.'),
        'formats': {},
    }
    hist = {'generatedAt': out['generatedAt'], 'unit': out['unit'], 'formats': {}}
    for key, sf in (('superflex', 1), ('1qb', 0)):
        sub = [r for r in rows if bool(r[0]) == bool(sf)]
        if len(sub) < 1000:
            continue
        print(f'  {key}: {len(sub):,} trades')
        res, h = fit_format(sub, names, lambdas, min_appear, 11 + sf)
        out['formats'][key] = res
        hist['formats'][key] = h
        top = ', '.join(f"{p['name']} {p['value']:.0f}" for p in res['players'][:5])
        print(f"    top: {top}; held-out {res['holdout']['medianAbsLogRatio']} vs static "
              f"{res['holdout']['static']} vs count {res['holdout']['countOnly']}")
    (outdir / 'player-trade-values.json').write_text(json.dumps(out, indent=1) + '\n')
    (outdir / 'player-trade-values-history.json').write_text(json.dumps(hist, separators=(',', ':')) + '\n')
    print(f'-> {outdir}/player-trade-values.json, player-trade-values-history.json')


if __name__ == '__main__':
    main()
