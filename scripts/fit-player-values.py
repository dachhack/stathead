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
with each league-season's n-th trade past LEAGUE_CAP weighted LEAGUE_CAP / n. A
player's value moves when trades move it: busy players follow the last days,
thin ones lean on months either side. LAMBDA is picked on held-out leagues.

  scale      100 = a mid 1st in the next rookie draft, that week (the pick is
             the numeraire, so seasonal pick hype moves every player a bit)
  additive   two 50s trade for one 100
  as of     every published value, current or past, uses only trades up to
             the end of its week: a forward pass refits the last WINDOW weeks
             of trades each week, tied to the as-of values before them. The
             smoothed all-history fit only picks LAMBDA (held-out leagues).
             Every player is fitted; the trade minimum only gates publishing,
             so later trades cannot change who is fitted, and league-season
             weights count only trades already made.
  formats    superflex and 1QB fitted separately; TE premium, team count and
             contender / rebuilder context are later steps.

Usage: python3 scripts/fit-player-values.py <dir> [--outdir=public/data]
       [--lambdas=1,3,10,30] [--min-appear=20] [--history-min=100]
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
WINDOW = 12           # as-of refits: weeks of trades in each window
PRIOR_K = 2.0         # weight of the as-of value carried into a window (x lambda)
BURN_IN = 26          # weeks the forward pass runs before the first reported week
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

    def __init__(self, rows, w0, n_weeks):
        # Every asset is fitted, however rarely traded; the minimum trade
        # count only decides what is published. Dropping rare players' trades
        # made the fitted set, and so every early value, depend on later
        # trades (a crawl cut off after week 20 moved values through week 20
        # by 3.7%). A rare player's value floats on little data, so his trades
        # barely move anyone else.
        appear = Counter(x for r in rows for x in r[4] + r[5])
        span = {}
        for _, _, _, created, a, b in rows:
            w = (created - w0) // WEEK_MS
            for asset in a + b:
                lo, hi = span.get(asset, (w, w))
                span[asset] = (min(lo, w), max(hi, w))
        self.keep = set(span)
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
    usable = sorted((r for r in rows if all(x in idx.offset for x in r[4] + r[5])), key=lambda r: r[3])
    ia, ja, ib, jb = [], [], [], []
    # A league-season's first LEAGUE_CAP trades weigh 1, its n-th after that
    # LEAGUE_CAP / n: the weight depends only on trades already made, so later
    # trades never re-weight earlier ones (as-of values stay as-of).
    seen = Counter()
    w = np.empty(len(usable))
    for i, (_, _, lg, created, a, b) in enumerate(usable):
        seen[lg] += 1
        wk = (created - w0) // WEEK_MS
        ia += [i] * len(a)
        ja += [idx.col(x, wk) for x in a]
        ib += [i] * len(b)
        jb += [idx.col(x, wk) for x in b]
        w[i] = min(1.0, LEAGUE_CAP / seen[lg])
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


def forward_filter(used, w, idx, w0, last, lam, t_start):
    """As-of values: the value at week t uses only trades up to the end of t.

    For each week t from t_start, refit on the trades of weeks t-WINDOW+1..t
    (a random walk over those weeks), with each asset's value at week t-WINDOW
    tied to its own as-of value then (PRIOR_K * lam), which carries all older
    history forward without any later trade leaking back. An asset with no
    trade in the window keeps its last as-of value. Returns a (weeks x assets)
    array of log-values (nan before an asset's first trade), the asset order,
    and the one-week-ahead error: this week's values pricing next week's
    trades, a true out-of-sample check.
    """
    gids = sorted(idx.offset, key=str)
    gid = {x: i for i, x in enumerate(gids)}
    ref = gid[('k', REF)]
    wk = np.array([(r[3] - w0) // WEEK_MS for r in used])
    order = np.argsort(wk, kind='stable')
    wk = wk[order]
    wts = w[order]
    sides = []
    for side in (4, 5):
        rr, gg = [], []
        for i, j in enumerate(order):
            for x in used[j][side]:
                rr.append(i)
                gg.append(gid[x])
        sides.append((np.array(rr), np.array(gg)))
    week_start = np.searchsorted(wk, np.arange(last + 2))
    n_g = len(gids)
    latest = np.full(n_g, np.nan)
    latest[ref] = 0.0
    snaps = {}
    errs = []
    prev = None   # (active gids, phi blocks) of the last step
    K = WINDOW + 1
    for t in range(t_start, last + 1):
        lo_w = t - WINDOW
        r0, r1 = week_start[max(lo_w + 1, 0)], week_start[t + 1]
        prior = snaps.get(lo_w)
        if r1 > r0:
            parts = []
            for rr, gg in sides:
                s0, s1 = np.searchsorted(rr, r0), np.searchsorted(rr, r1)
                parts.append((rr[s0:s1] - r0, gg[s0:s1], wk[rr[s0:s1]] - lo_w))
            active = np.unique(np.concatenate([parts[0][1], parts[1][1], [ref]]))
            n_a = len(active)
            mats = []
            for rows_, gg, kk in parts:
                cols = np.searchsorted(active, gg) * K + kk
                mats.append(sparse.csr_matrix((np.ones(len(cols)), (rows_, cols)), shape=(r1 - r0, n_a * K)))
            A, B = mats
            ix = np.arange(n_a * K).reshape(n_a, K)
            nd = n_a * WINDOW
            D = sparse.csr_matrix((np.r_[-np.ones(nd), np.ones(nd)],
                                   (np.r_[np.arange(nd), np.arange(nd)], np.r_[ix[:, :-1].ravel(), ix[:, 1:].ravel()])),
                                  shape=(nd, n_a * K))
            fixed = ix[np.searchsorted(active, ref)]
            anchor = ix[:, 0]
            pv = prior[active] if prior is not None else np.full(n_a, np.nan)
            has = ~np.isnan(pv)
            # Start from last week's solution shifted a week, else the prior,
            # else the asset's latest value, else a low default.
            x0 = np.full((n_a, K), np.log(0.3))
            base = np.where(has, pv, latest[active])
            base = np.where(np.isnan(base), np.log(0.3), base)
            x0[:] = base[:, None]
            if prev is not None:
                pa, pphi = prev
                pos = np.searchsorted(pa, active)
                hit = (pos < len(pa)) & (pa[np.minimum(pos, len(pa) - 1)] == active)
                x0[hit, :-1] = pphi[pos[hit], 1:]
                x0[hit, -1] = pphi[pos[hit], -1]
            x0 = x0.ravel()
            x0[fixed] = 0.0
            w_win = wts[r0:r1]
            DtD = (D.T @ D).tocsr()
            pk = PRIOR_K * lam

            def f(phi):
                phi = phi.copy()
                phi[fixed] = 0.0
                v = np.exp(phi)
                sa, sb = A @ v, B @ v
                r = np.log(sa) - np.log(sb)
                sq = np.sqrt(1 + (r / DELTA) ** 2)
                loss = np.sum(w_win * 2 * DELTA ** 2 * (sq - 1))
                dr = w_win * r / sq
                g = v * (A.T @ (dr / sa) - B.T @ (dr / sb))
                Dp = DtD @ phi
                loss += lam * float(phi @ Dp)
                g += 2 * lam * Dp
                dev = np.where(has, phi[anchor] - np.nan_to_num(pv), 0.0)
                loss += pk * float(dev @ dev)
                g[anchor] += 2 * pk * dev
                g[fixed] = 0.0
                return loss, g

            res = minimize(f, x0, jac=True, method='L-BFGS-B', options={'maxiter': 500, 'maxcor': 20})
            phi = res.x.reshape(n_a, K)
            phi[np.searchsorted(active, ref)] = 0.0
            latest[active] = phi[:, -1]
            prev = (active, phi)
        snaps[t] = latest.copy()
        # Next week's trades priced with this week's as-of values.
        n0, n1 = week_start[t + 1], week_start[min(t + 2, last + 1)]
        if n1 > n0:
            sums = []
            for rr, gg in sides:
                s0, s1 = np.searchsorted(rr, n0), np.searchsorted(rr, n1)
                vals = np.exp(latest[gg[s0:s1]])
                sums.append(np.bincount(rr[s0:s1] - n0, weights=vals, minlength=n1 - n0))
            ok = np.isfinite(sums[0]) & np.isfinite(sums[1]) & (sums[0] > 0) & (sums[1] > 0)
            errs.extend(np.abs(np.log(sums[0][ok]) - np.log(sums[1][ok])).tolist())
    weeks = sorted(snaps)
    return np.array([snaps[t] for t in weeks]), weeks, gids, (float(np.median(errs)) if errs else None), len(errs)


def slope(logs):
    """Least-squares slope per week of a log-value series (nan-free)."""
    n = len(logs)
    if n < 3:
        return None
    x = np.arange(n) - (n - 1) / 2
    return float(np.dot(x, logs - logs.mean()) / np.dot(x, x))


def implied_spread(used, snaps, col_of, w0, t_start, last, weeks=4):
    """Per player: log(implied / as-of value) over his trades in the last
    `weeks` weeks. The implied value is what balances the trade given every
    other asset's as-of value that week: the other side's total minus his own
    side's other assets. Skipped where that is not positive."""
    out = defaultdict(list)
    for _, _, _, created, a, b in used:
        k = (created - w0) // WEEK_MS
        if k <= last - weeks or k < t_start:
            continue
        row = snaps[k - t_start]
        va = {x: np.exp(row[col_of[x]]) for x in a}
        vb = {x: np.exp(row[col_of[x]]) for x in b}
        if any(np.isnan(v) for v in list(va.values()) + list(vb.values())):
            continue
        sa, sb = sum(va.values()), sum(vb.values())
        for mine, s_mine, s_other in ((va, sa, sb), (vb, sb, sa)):
            for x, v in mine.items():
                if x[0] != 'p':
                    continue
                imp = s_other - (s_mine - v)
                if imp > 0:
                    out[x].append(float(np.log(imp / v)))
    return out


def meta_stats(series, spreads):
    """Trend, velocity, variability and confidence from an as-of log-value
    series (one value per week, nan before the first trade) and the player's
    recent implied-value spreads. All from as-of values: no look-ahead."""
    ok = ~np.isnan(series)
    s = series[ok]
    m = {}
    for ago in (1, 4, 12):
        if len(s) > ago:
            m[f'change{ago}w'] = round(float(np.exp(s[-1] - s[-1 - ago]) - 1), 4)
    v_now = slope(s[-5:]) if len(s) >= 5 else None
    v_prev = slope(s[-9:-4]) if len(s) >= 9 else None
    if v_now is not None:
        m['velocity'] = round(float(np.exp(v_now) - 1), 4)
    if v_now is not None and v_prev is not None:
        m['acceleration'] = round(float(np.exp(v_now) - np.exp(v_prev)), 4)
    steps = np.diff(s[-13:])
    vol = float(np.std(steps, ddof=1)) if len(steps) >= 4 else None
    if vol is not None:
        m['volatility'] = round(float(np.exp(vol) - 1), 4)
    if 'change4w' in m and vol:
        # A 4-week move beyond twice what four weeks of ordinary weekly noise
        # would give (2 x vol x sqrt(4)) is a trend.
        z = np.log(1 + m['change4w']) / (vol * 2)
        m['trend'] = 'rising' if z > 2 else 'falling' if z < -2 else 'flat'
    hi = s[-52:]
    m['high52w'] = round(float(100 * np.exp(hi.max())), 1)
    m['low52w'] = round(float(100 * np.exp(hi.min())), 1)
    m['fromHigh'] = round(float(np.exp(s[-1] - hi.max()) - 1), 4)
    if len(spreads) >= 3:
        r = np.array(spreads)
        mad = float(np.median(np.abs(r - np.median(r))))
        sd = 1.4826 * mad
        m['dispersion'] = round(float(np.exp(sd) - 1), 4)
        # Trade disagreement over the count, plus the value's own weekly
        # wobble: the as-of value lags and moves, which the trades' spread
        # alone does not see (alone, the range covered 44% on synthetic data).
        se = np.sqrt(sd ** 2 / len(r) + (vol or 0.0) ** 2)
        m['ciLow'] = round(float(100 * np.exp(s[-1] - 1.645 * se)), 1)
        m['ciHigh'] = round(float(100 * np.exp(s[-1] + 1.645 * se)), 1)
    return m


def fit_format(rows, names, lambdas, min_appear, seed, history_min=HISTORY_MIN):
    w0 = min(r[3] for r in rows)
    w0 -= w0 % WEEK_MS
    n_weeks = int((max(r[3] for r in rows) - w0) // WEEK_MS) + 1
    idx = Index(rows, w0, n_weeks)
    D = idx.diffs()
    print(f'    {idx.n:,} parameters over {n_weeks} weeks, {sum(1 for x in idx.offset if x[0] == "p"):,} players '
          f'({sum(1 for x in idx.offset if x[0] == "p" and idx.appear[x] >= min_appear):,} in {min_appear}+ trades)')

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
    t_start = max(0, last - HISTORY_WEEKS - BURN_IN)
    snaps, weeks, gids, fc_err, fc_n = forward_filter(used, w, idx, w0, last, best, t_start)
    # The smoothed fit priced the same next-week trades in-sample (it saw them).
    sm_err = []
    for _, _, _, created, a, b in used:
        k = (created - w0) // WEEK_MS
        if k >= t_start + 1:
            va = sum(np.exp(phi[idx.col(x, k)]) for x in a)
            vb = sum(np.exp(phi[idx.col(x, k)]) for x in b)
            sm_err.append(abs(np.log(va / vb)))
    print(f'    as-of pass: weeks {week_date(weeks[0])}..{week_date(weeks[-1])}, next-week error '
          f'{fc_err:.3f} on {fc_n:,} trades (smoothed, in-sample: {np.median(sm_err):.3f})')
    col_of = {x: i for i, x in enumerate(gids)}
    recent, r4, r1 = Counter(), Counter(), Counter()
    for _, _, _, created, a, b in used:
        k = (created - w0) // WEEK_MS
        for x in a + b:
            if k > last - 8:
                recent[x] += 1
            if k > last - 4:
                r4[x] += 1
            if k == last:
                r1[x] += 1
    spreads = implied_spread(used, snaps, col_of, w0, weeks[0], last)
    players, history = [], {}
    for x in gids:
        if x[0] != 'p':
            continue
        if idx.appear[x] < min_appear:
            continue   # fitted, not published: too few trades to stand alone
        series = snaps[:, col_of[x]]
        if np.isnan(series[-1]):
            continue   # last traded before the as-of pass began
        vals = 100 * np.exp(series)
        nm, pos = names.get(x[1], (None, None))
        row = {'sleeper_id': x[1], 'name': nm, 'pos': pos, **({'idp': True} if pos in IDP_POS else {}),
               'value': round(float(vals[-1]), 1), 'lastTraded': week_date(idx.span[x][1]),
               'trades1w': r1[x], 'trades4w': r4[x], 'trades8w': recent[x], 'tradesAll': idx.appear[x],
               **meta_stats(series, spreads.get(x, []))}
        for ago in (4, 12, 52):
            if len(vals) > ago and not np.isnan(series[-1 - ago]):
                row[f'value{ago}wAgo'] = round(float(vals[-1 - ago]), 1)
        players.append(row)
        if idx.appear[x] >= history_min:
            keep = np.where(~np.isnan(series))[0]
            first = max(keep[0], len(weeks) - HISTORY_WEEKS)
            history[x[1]] = {'from': week_date(weeks[first]), 'v': [round(float(v), 1) for v in vals[first:]]}
    players.sort(key=lambda r: -r['value'])
    # Ranks on StatHead values, offense only (IDP values come from IDP leagues).
    pos_n = Counter()
    for i, row in enumerate(p for p in players if not p.get('idp') and p.get('pos') in ('QB', 'RB', 'WR', 'TE')):
        pos_n[row['pos']] += 1
        row['rank'], row['posRank'] = i + 1, pos_n[row['pos']]
    picks = []
    for c in range(N_CELLS):
        if ('k', c) not in col_of:
            continue
        r, a, t = cell_key(c)
        v = snaps[-1, col_of[('k', c)]]
        if np.isnan(v):
            continue
        picks.append({'round': r, 'ahead': a, 'tier': t, 'value': round(float(100 * np.exp(v)), 1),
                      'n': idx.appear.get(('k', c), 0)})
    return {
        'trades': len(used), 'weeks': n_weeks, 'from': week_date(0), 'to': week_date(last),
        'lambda': best,
        'nextWeek': {'trades': fc_n, 'asOfError': round(fc_err, 3) if fc_err is not None else None,
                     'smoothedInSample': round(float(np.median(sm_err)), 3),
                     'note': 'median |log(side A / side B)| of each week\'s trades priced with the previous week\'s '
                             'as-of values (out of sample), and by the smoothed fit, which had seen them'},
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
    history_min = int(args.get('history-min', HISTORY_MIN))
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
        'fields': {
            'change1w / change4w / change12w': 'change in the as-of value over 1, 4, 12 weeks (0.10 = +10%)',
            'velocity': 'weekly rate of change: least-squares slope of log value over the last 4 weeks (0.05 = +5%/week)',
            'acceleration': 'velocity now minus velocity over the 4 weeks before',
            'volatility': 'standard deviation of weekly changes over the last 12 weeks (0.05 = 5%/week)',
            'trend': 'rising / falling / flat: the 4-week change beyond twice what 4 weeks of ordinary weekly '
                     'noise (volatility) would give',
            'dispersion': 'how much the last 4 weeks of trades disagree: robust spread of the value each trade implies '
                          'for the player (the other side\'s total minus his own side\'s other assets), as a %',
            'ciLow / ciHigh': '90% range for the current value: trade dispersion over the 4-week count, plus the '
                              'value\'s own weekly volatility',
            'high52w / low52w / fromHigh': '52-week as-of range, and the current value against the high',
            'rank / posRank': 'rank on StatHead value, offense only (QB/RB/WR/TE), overall and in position',
            'trades1w / trades4w / trades8w / tradesAll': 'trades the player was in: liquidity',
        },
        'note': ('value: as of the newest week. valueNwAgo: the value as it stood N weeks ago, from trades up '
                 'to then only (the history file is as-of too). lastTraded: the week of the player\'s last trade. '
                 'trades8w / tradesAll: trades the player was in. '
                 'idp: a defensive player, valued from IDP leagues only. '
                 f'Every player is fitted; players in fewer than {min_appear} trades are not published.'),
        'formats': {},
    }
    hist = {'generatedAt': out['generatedAt'], 'unit': out['unit'], 'formats': {}}
    for key, sf in (('superflex', 1), ('1qb', 0)):
        sub = [r for r in rows if bool(r[0]) == bool(sf)]
        if len(sub) < 1000:
            continue
        print(f'  {key}: {len(sub):,} trades')
        res, h = fit_format(sub, names, lambdas, min_appear, 11 + sf, history_min)
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
