#!/usr/bin/env python3
"""StatHead rookie-pick values fitted to real pick-for-pick trades.

Input: the trade database (scripts/build-sleeper-trade-db.py, --lite is enough).
Output: public/data/pick-values.json, StatHead model output only: values per
pick class with the number of trades behind each, never a trade, league or
manager (docs/third-party-data-policy.md).

MARKET VALUE. Every completed two-team trade where both sides send only rookie picks
(no players, no FAAB, no startup picks) is read as an even swap: both managers accepted it. Each
pick falls in a class:
  round      1-4, 5 = fifth or later
  ahead      seasons until its draft at the trade: 0 = the league's next
             rookie draft (by its own draft date; calendar Jan-Aug / Sep-Dec
             where that draft is not crawled), 1, 2, 3 = 3+
  tier       E / M / L = early / mid / late, from the original owner's standing
             at the trade (worst third of the league -> E); U = owner unknown
             (not one of the two sides) or no standing yet
Values v = exp(phi) per class are fitted so the sides' sums match, on the log
of the ratio with a soft-L1 loss (lopsided and collusive swaps count less),
each league-season's trades capped at 5 trades' weight, a ridge toward the
round-and-ahead mean for thin tiers, and 100 = a mid first in the next draft.
The scale is additive: two 50s trade for one 100. (A consolidation premium,
summing v^k with k > 1, is not identifiable from even swaps alone: any k
gives the same fit on a power-transformed scale, so the additive one is
reported.)

  global     every trade
  byYear     per calendar year of the trade, ridge-pooled toward global
  current    the last 120 days of trades, ridge-pooled toward global
  90% intervals: bootstrap over leagues (lineages) for global and current —
             the point estimate plus the replicate spread about the replicate
             mean, with the replicates refitted the same way (pooled for
             current), so an interval always holds its value

REALIZED VALUE. What a rookie-draft slot actually returned: for drafted
players of classes with 3 seasons played (crosswalk sleeper_id -> gsis,
nflverse weekly PPR), the best PPR per game over a season of 6+ games in
seasons 1-3, and the share who had a 12+ PPR/game season. Per round and slot
tier, over every crawled rookie draft (each league's pick counts once).

Usage: python3 scripts/fit-pick-values.py <dir> [--out=public/data/pick-values.json]
       [--boot=20]
"""
from __future__ import annotations

import csv
import gzip
import io
import json
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from scipy import sparse
from scipy.optimize import minimize

from trade_values_common import (AHEAD, N_CELLS, ROUNDS, STARTUP_ROUNDS, TIERS, DraftCalendar,
                                 StartupFilter, cell, cell_key, standings, tier_of)

REF = (1, 0, 'M')          # 100 = a mid first in the next rookie draft
DELTA = 0.5                # soft-L1 scale on log(side A / side B)
LEAGUE_CAP = 5             # a league-season's trades weigh at most this many
RIDGE_TIER = 0.5           # thin tiers shrink to their round-and-ahead mean
RIDGE_POOL = 2.0           # year / current fits shrink toward global
CURRENT_DAYS = 120
MIN_N = 30                 # a class with fewer pick appearances is flagged thin
HIT_PPG = 12.0
DATA = Path('public/data')

PICK_ONLY = "t.n_sides = 2 AND t.n_players = 0 AND t.faab_total = 0 AND t.n_picks > 0"


def load_trades(db):
    """Pick-for-pick swaps: [(sf, lineage, lg, created, side A cells, side B cells)].

    Startup picks are dropped (trade_values_common.StartupFilter): the first
    full run (2026-10-20) without that rule had a superflex 1st one year out
    at 21 on a scale where a mid 1st in the next draft is 100. Seasons ahead
    count from the league's own next rookie draft (DraftCalendar).
    """
    startup = StartupFilter(db)
    calendar = DraftCalendar(db)
    sides = standings(db, PICK_ONLY)
    trades = {}
    for tid, lineage, lg, season, created, sf, typ in db.execute(
            f"SELECT t.id, t.lineage, t.lg, t.season, t.created, t.sf, t.type FROM trades t WHERE {PICK_ONLY} "
            "AND t.type IN ('dynasty', 'keeper') AND t.created IS NOT NULL"):
        trades[tid] = {'sf': sf, 'lineage': lineage, 'lg': lg, 'season': season, 'created': created,
                       'to': defaultdict(list), 'bad': False}
    dropped_startup = 0
    for tid, frm, to, season, rnd, orig, draft in db.execute(
            "SELECT trade_id, from_rid, to_rid, pick_season, pick_round, pick_orig_rid, pick_draft FROM trade_assets WHERE kind = 'pick'"):
        t = trades.get(tid)
        if t is None:
            continue
        if season is None or rnd is None:
            t['bad'] = True
            continue
        if startup.is_startup(t['lg'], t['season'], season, rnd, draft):
            dropped_startup += not t['bad']
            t['bad'] = True
            continue
        ahead = calendar.ahead(t['lineage'], t['created'], season)
        if ahead < 0:
            t['bad'] = True
            continue
        rank, teams = sides.get(tid, {}).get(orig, (None, None))
        t['to'][to].append(cell(rnd, ahead, tier_of(rank, teams)))
    out = []
    for tid, t in trades.items():
        if t['bad'] or len(t['to']) != 2:
            continue
        a, b = list(t['to'].values())
        out.append((t['sf'], t['lineage'], t['lg'], t['created'], a, b))
    print(f'  dropped {dropped_startup:,} trades holding startup picks')
    return out


def design(rows):
    """Sparse count matrices (trades x cells) for each side, and weights."""
    n = len(rows)
    ia, ja, ib, jb = [], [], [], []
    per_lg = defaultdict(int)
    for _, _, lg, _, _, _ in rows:
        per_lg[lg] += 1
    w = np.empty(n)
    for i, (_, _, lg, _, a, b) in enumerate(rows):
        ia += [i] * len(a)
        ja += a
        ib += [i] * len(b)
        jb += b
        w[i] = min(1.0, LEAGUE_CAP / per_lg[lg])
    A = sparse.csr_matrix((np.ones(len(ia)), (ia, ja)), shape=(n, N_CELLS))
    B = sparse.csr_matrix((np.ones(len(ib)), (ib, jb)), shape=(n, N_CELLS))
    return A, B, w


def fit(A, B, w, prior=None, ridge_pool=0.0, x0=None):
    ref = cell(*REF)
    groups = np.arange(N_CELLS) // len(TIERS)

    def f(phi):
        phi = phi.copy()
        phi[ref] = 0.0
        v = np.exp(phi)
        sa, sb = A @ v, B @ v
        r = np.log(sa) - np.log(sb)
        s = np.sqrt(1 + (r / DELTA) ** 2)
        loss = np.sum(w * 2 * DELTA ** 2 * (s - 1))
        dr = 2 * w * r / s                      # d loss / d r: 2 DELTA^2 (s - 1) -> 2 r / s
        g = v * (A.T @ (dr / sa) - B.T @ (dr / sb))
        # Ridge: tiers toward their round-and-ahead mean.
        means = np.bincount(groups, phi) / len(TIERS)
        dev = phi - means[groups]
        loss += RIDGE_TIER * np.sum(dev ** 2)
        g += 2 * RIDGE_TIER * (dev - np.bincount(groups, dev)[groups] / len(TIERS))
        if prior is not None and ridge_pool:
            loss += ridge_pool * np.sum((phi - prior) ** 2)
            g += 2 * ridge_pool * (phi - prior)
        g[ref] = 0.0
        return loss, g

    start = x0 if x0 is not None else np.zeros(N_CELLS)
    res = minimize(f, start, jac=True, method='L-BFGS-B', options={'maxiter': 2000})
    phi = res.x.copy()
    phi[ref] = 0.0
    return phi


def counts(A, B):
    return np.asarray((A.sum(axis=0) + B.sum(axis=0))).ravel()


def cells_out(phi, n, lo=None, hi=None):
    rows = []
    for c in range(N_CELLS):
        r, a, t = cell_key(c)
        row = {'round': r, 'ahead': a, 'tier': t, 'value': round(100 * float(np.exp(phi[c])), 1), 'n': int(n[c])}
        if not n[c]:
            rows.append({'round': r, 'ahead': a, 'tier': t, 'value': None, 'n': 0})
            continue
        if lo is not None:
            row['lo'] = round(100 * float(np.exp(lo[c])), 1)
            row['hi'] = round(100 * float(np.exp(hi[c])), 1)
        if n[c] < MIN_N:
            row['thin'] = True
        rows.append(row)
    return rows


def bootstrap(rows, phi0, reps, seed, prior=None, ridge_pool=0.0):
    """90% interval per class: refit on resamples of leagues (lineages) with
    the SAME fit as the point estimate (prior / ridge_pool for a pooled fit),
    then take the point estimate plus the replicate spread about the
    replicate mean. A straight percentile interval of the replicates sat
    beside the point estimate whenever the two fits differed: the first
    current-window intervals were unpooled replicates around a pooled
    point, and 46 of 77 cells fell outside their own interval."""
    if reps <= 0:
        return None, None
    rng = np.random.default_rng(seed)
    by_lin = defaultdict(list)
    for r in rows:
        by_lin[r[1]].append(r)
    lins = list(by_lin)
    draws = []
    for _ in range(reps):
        pick = rng.integers(0, len(lins), len(lins))
        sample = [r for i in pick for r in by_lin[lins[i]]]
        A, B, w = design(sample)
        draws.append(fit(A, B, w, prior, ridge_pool, x0=phi0))
    d = np.array(draws) - np.mean(draws, axis=0)
    return phi0 + np.percentile(d, 5, axis=0), phi0 + np.percentile(d, 95, axis=0)


def fit_format(rows, reps, seed):
    A, B, w = design(rows)
    phi = fit(A, B, w)
    lo, hi = bootstrap(rows, phi, reps, seed)
    out = {'trades': len(rows), 'global': cells_out(phi, counts(A, B), lo, hi), 'byYear': {}}
    by_year = defaultdict(list)
    for r in rows:
        by_year[datetime.fromtimestamp(r[3] / 1000, timezone.utc).year].append(r)
    for y, yr in sorted(by_year.items()):
        if len(yr) < 200:
            continue
        Ay, By, wy = design(yr)
        out['byYear'][str(y)] = {'trades': len(yr), 'cells': cells_out(fit(Ay, By, wy, phi, RIDGE_POOL, phi), counts(Ay, By))}
    last = max(r[3] for r in rows)
    cur = [r for r in rows if r[3] >= last - CURRENT_DAYS * 86400 * 1000]
    if len(cur) >= 200:
        Ac, Bc, wc = design(cur)
        phic = fit(Ac, Bc, wc, phi, RIDGE_POOL, phi)
        lo_c, hi_c = bootstrap(cur, phic, reps, seed + 1, phi, RIDGE_POOL)
        out['current'] = {
            'from': datetime.fromtimestamp((last - CURRENT_DAYS * 86400 * 1000) / 1000, timezone.utc).date().isoformat(),
            'to': datetime.fromtimestamp(last / 1000, timezone.utc).date().isoformat(),
            'trades': len(cur), 'cells': cells_out(phic, counts(Ac, Bc), lo_c, hi_c)}
    # Held-out check: fit on 80% of leagues, score the rest (median |log ratio|).
    lins = sorted({r[1] for r in rows})
    rng = np.random.default_rng(seed + 2)
    test_lins = set(rng.choice(lins, max(1, len(lins) // 5), replace=False)) if lins else set()
    tr = [r for r in rows if r[1] not in test_lins]
    te = [r for r in rows if r[1] in test_lins]
    if tr and te:
        At, Bt, wt = design(tr)
        p = fit(At, Bt, wt)
        Ae, Be, _ = design(te)
        v = np.exp(p)
        err = np.abs(np.log(Ae @ v) - np.log(Be @ v))
        Ae0, Be0, _ = design(te)
        base = np.abs(np.log(np.asarray(Ae0.sum(axis=1)).ravel()) - np.log(np.asarray(Be0.sum(axis=1)).ravel()))
        out['holdout'] = {'trades': len(te), 'medianAbsLogRatio': round(float(np.median(err)), 3),
                          'baselineCountOnly': round(float(np.median(base)), 3),
                          'note': 'median |log(side A / side B)| on held-out leagues; baseline values every pick at 1'}
    return out


def realized(db):
    """Rookie-draft slot -> what the drafted player returned (classes with 3 seasons)."""
    xw = {p['sleeper_id']: p['gsis_id'] for p in json.loads((DATA / 'player-crosswalk.json').read_text())['players']
          if p.get('sleeper_id') and p.get('gsis_id')}
    ppg = defaultdict(dict)  # gsis -> season -> PPR per game (REG, 6+ games)
    seasons = []
    for y in range(2018, 2030):
        f = DATA / f'player_stats_{y}.csv.gz'
        if not f.exists():
            continue
        tot = defaultdict(lambda: [0.0, 0])
        with gzip.open(f, 'rt') as fh:
            for r in csv.DictReader(fh):
                if r.get('season_type') != 'REG':
                    continue
                t = tot[r['player_id']]
                t[0] += float(r.get('fantasy_points_ppr') or 0)
                t[1] += 1
        for g, (pts, n) in tot.items():
            if n >= 6:
                ppg[g][y] = pts / n
        seasons.append(y)
    if not seasons:
        return None
    # A class needs three finished seasons: the newest season counts only once
    # it has 17 weeks of games, which the 6-game rule approximates poorly in
    # October; use seasons strictly before the newest file.
    last_full = max(seasons) - 1
    cells = defaultdict(lambda: [0, 0.0, 0])  # (round, tier) -> n, sum best, hits
    seen = set()
    for draft, season, teams, ptype, rounds, pick_no, rnd, slot, pid in db.execute(
            'SELECT d.draft, d.season, d.teams, d.player_type, d.rounds, p.pick_no, p.round, p.slot, p.player_id '
            'FROM draft_picks p JOIN drafts d ON d.draft = p.draft WHERE d.status = ?', ('complete',)):
        rookie = ptype == 1 or (rounds or 99) <= 6
        if not rookie or not season or not teams or season + 2 > last_full or not pid:
            continue
        if (draft, pick_no) in seen:
            continue
        seen.add((draft, pick_no))
        g = xw.get(str(pid))
        best = max((ppg.get(g, {}).get(y, 0.0) for y in range(season, season + 3)), default=0.0) if g else 0.0
        frac = (slot - 1) / max(teams - 1, 1) if slot else 0.5
        tier = 'E' if frac < 1 / 3 else 'M' if frac < 2 / 3 else 'L'
        c = cells[(min(rnd, ROUNDS), tier)]
        c[0] += 1
        c[1] += best
        c[2] += best >= HIT_PPG
    rows = [{'round': r, 'tier': t, 'n': n, 'bestPPG': round(s / n, 2), 'hitRate': round(h / n, 3)}
            for (r, t), (n, s, h) in sorted(cells.items()) if n >= MIN_N]
    return {'classesThrough': last_full - 2, 'hitPPG': HIT_PPG, 'cells': rows, 'note': (
        'Rookie drafts in crawled leagues, classes with three finished seasons. bestPPG: the drafted '
        "player's best PPR per game over a 6+ game season in years 1-3 (0 if none). hitRate: share with "
        f'a {HIT_PPG:g}+ season. Undrafted-by-NFL and unmatched players count as 0.')}


def main() -> None:
    args = dict(a.lstrip('-').split('=', 1) for a in sys.argv[1:] if a.startswith('--') and '=' in a)
    d = Path(next(a for a in sys.argv[1:] if not a.startswith('--')))
    reps = int(args.get('boot', 20))
    db = sqlite3.connect(d / 'sleeper-trades.sqlite')
    rows = load_trades(db)
    print(f'{len(rows):,} pick-for-pick trades')
    out = {
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'source': 'StatHead fit to completed pick-for-pick trades in public Sleeper dynasty and keeper leagues',
        'unit': '100 = a mid first-round pick in the next rookie draft; additive (two 50s trade for one 100)',
        'classes': {'round': '1-4; 5 = fifth or later', 'ahead': '0 = next rookie draft, 1, 2, 3 = 3+ seasons out',
                    'tier': 'E/M/L = early/mid/late from the original owner\'s standing at the trade; U = unknown'},
        'formats': {},
    }
    for key, sf in (('superflex', 1), ('1qb', 0)):
        sub = [r for r in rows if bool(r[0]) == bool(sf)]
        if len(sub) < 200:
            continue
        out['formats'][key] = fit_format(sub, reps, 7 + sf)
        g = {(c['round'], c['ahead'], c['tier']): c for c in out['formats'][key]['global']}
        print(f"  {key}: {len(sub):,} trades; 1st next M 100, 2nd next M {g[(2, 0, 'M')]['value']}, "
              f"1st +1yr U {g[(1, 1, 'U')]['value']}, 1st next E {g[(1, 0, 'E')]['value']} / L {g[(1, 0, 'L')]['value']}"
              + (f"; holdout {out['formats'][key]['holdout']['medianAbsLogRatio']} vs {out['formats'][key]['holdout']['baselineCountOnly']}"
                 if 'holdout' in out['formats'][key] else ''))
    out['realized'] = realized(db)
    dest = Path(args.get('out', DATA / 'pick-values.json'))
    dest.write_text(json.dumps(out, indent=1) + '\n')
    print(f'-> {dest}')


if __name__ == '__main__':
    main()
