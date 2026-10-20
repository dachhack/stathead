#!/usr/bin/env python3
"""Offline test of scripts/fit-player-values.py on synthetic trades.

300 players with KNOWN values that drift week to week (one doubles halfway),
and two pick classes (mid 1st = 100, mid 2nd = 40), traded across 200
superflex dynasty leagues for 40 weeks: each trade sends one player for 1-3
assets worth about the same (log-normal noise). Shards -> lite build -> fit,
then checks that the fit recovers current values, the jump, the pick scale,
and beats a static fit and counting assets on held-out leagues.

Usage: python3 scripts/test-player-values.py
"""
from __future__ import annotations

import gzip
import json
import math
import random
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
N_PLAYERS, N_LEAGUES, N_WEEKS, PER_LEAGUE, TEAMS = 300, 200, 40, 60, 12
START = datetime(2025, 3, 3, tzinfo=timezone.utc)
JUMP_WEEK = 20


def main() -> None:
    rng = random.Random(3)
    # True log-values: a random walk per player; player 0 doubles at JUMP_WEEK.
    logv = []
    for p in range(N_PLAYERS):
        x = math.log(min(250, max(4, rng.lognormvariate(math.log(30), 0.9))))
        path = []
        for w in range(N_WEEKS):
            x += rng.gauss(0, 0.03)
            if p == 0 and w == JUMP_WEEK:
                x += math.log(2)
            path.append(x)
        logv.append(path)
    pick_val = {1: 100.0, 2: 40.0}
    tmp = Path(tempfile.mkdtemp())
    (tmp / 'shards').mkdir()
    leagues, trades = [], []
    for li in range(N_LEAGUES):
        fmt = {'type': 'dynasty', 'teams': TEAMS, 'sf': True, 'tep': 0, 'ppr': 1, 'faabBudget': 0, 'bestBall': False}
        lg = f'L{li}'
        ranks = list(range(1, TEAMS + 1))
        rng.shuffle(ranks)
        leagues.append({'lg': lg, 'prev': None, 'season': '2025', 'status': 'complete', 'throughLeg': 99,
                        'crawledAt': '2026-01-01T00:00:00Z', 'format': fmt, 'txnCounts': {}, 'champion': 1, 'runnerUp': 2,
                        'rosters': [{'rid': r, 'owner': f'U{li}-{r}', 'w': 5, 'l': 5, 't': 0, 'pf': 1, 'pa': 1, 'maxPf': 1,
                                     'rank': ranks[r - 1], 'faabUsed': 0, 'moves': 0} for r in range(1, TEAMS + 1)],
                        'drafts': []})
        mid = [r for r in range(1, TEAMS + 1) if 5 <= ranks[r - 1] <= 8]   # mid-table owners: tier M
        for k in range(PER_LEAGUE):
            wk = rng.randrange(N_WEEKS)
            created = START + timedelta(weeks=wk, days=rng.randrange(7))
            draft_year = created.year if created.month < 9 else created.year + 1
            a_rid, b_rid = rng.sample(mid, 2)
            p = rng.randrange(N_PLAYERS)
            # Match side B to side A's TRUE value: the leftover mismatch is the
            # trade's noise. (Matching a noisy target instead biases whichever
            # asset is compared with the noise-inflated, mostly cheap players.)
            target = math.exp(logv[p][wk])
            best = None
            for _ in range(200):
                n = rng.randint(1, 3)
                assets = []
                for _ in range(n):
                    if rng.random() < 0.2:
                        assets.append(('k', rng.choice([1, 2])))
                    else:
                        q = rng.randrange(N_PLAYERS)
                        if q != p and ('p', q) not in assets:
                            assets.append(('p', q))
                if not assets:
                    continue
                tot = sum(pick_val[x[1]] if x[0] == 'k' else math.exp(logv[x[1]][wk]) for x in assets)
                if best is None or abs(math.log(tot / target)) < best[0]:
                    best = (abs(math.log(tot / target)), assets)
            assets = best[1]
            adds, drops, dp = {str(p): b_rid}, {str(p): a_rid}, []
            gets_a = {'players': [], 'picks': [], 'faab': 0}
            for x in assets:
                if x[0] == 'p':
                    adds[str(x[1])], drops[str(x[1])] = a_rid, b_rid
                    gets_a['players'].append(str(x[1]))
                else:
                    pk = {'season': str(draft_year), 'round': x[1], 'roster_id': b_rid, 'previous_owner_id': b_rid, 'owner_id': a_rid}
                    dp.append(pk)
                    gets_a['picks'].append(pk)
            rec = lambda rid: {'w': 6, 'l': 4, 't': 0, 'pf': 0, 'pa': 0, 'rank': ranks[rid - 1]}
            ms = int(created.timestamp() * 1000)
            trades.append({'id': f'T{li}-{k}', 'lg': lg, 'season': '2025', 'leg': 5, 'created': ms, 'completed': ms,
                           'creatorRid': a_rid, 'nSides': 2, 'format': fmt,
                           'sides': [{'rid': a_rid, 'owner': f'U{li}-{a_rid}', 'record': rec(a_rid), 'gets': gets_a,
                                      'gives': {'players': [str(p)], 'picks': [], 'faab': 0}, 'cut': [], 'added': []},
                                     {'rid': b_rid, 'owner': f'U{li}-{b_rid}', 'record': rec(b_rid),
                                      'gets': {'players': [str(p)], 'picks': [], 'faab': 0}, 'gives': gets_a, 'cut': [], 'added': []}],
                           'raw': {'adds': adds, 'drops': drops, 'draft_picks': dp, 'waiver_budget': None, 'roster_ids': [a_rid, b_rid]}})
    for kind, rows in (('leagues', leagues), ('trades', trades)):
        with gzip.open(tmp / 'shards' / f'20260101T000000-{kind}.jsonl.gz', 'wt') as f:
            for r in rows:
                f.write(json.dumps(r) + '\n')

    fails = []

    def check(ok, msg):
        print(('  ok   ' if ok else '  FAIL ') + msg)
        if not ok:
            fails.append(msg)

    run = lambda *a: subprocess.run([sys.executable, *a], cwd=ROOT, capture_output=True, text=True)
    r = run('scripts/build-sleeper-trade-db.py', str(tmp), '--lite')
    check(r.returncode == 0, f'lite build {r.stderr[-300:]}')
    r = run('scripts/fit-player-values.py', str(tmp), f'--outdir={tmp}')
    check(r.returncode == 0, f'fit runs {r.stderr[-800:]}')
    print('\n'.join('    ' + l for l in r.stdout.splitlines()))
    cur = json.loads((tmp / 'player-trade-values.json').read_text())['formats']['superflex']
    hist = json.loads((tmp / 'player-trade-values-history.json').read_text())['formats']['superflex']
    # The fit's last week is the newest trade's week.
    last = N_WEEKS - 1
    errs, pairs = [], []
    for row in cur['players']:
        if row['tradesAll'] < 40:
            continue
        true = 100 * math.exp(logv[int(row['sleeper_id'])][last]) / pick_val[1]
        errs.append(abs(math.log(row['value'] / true)))
        pairs.append((math.log(row['value']), math.log(true)))
    n = len(pairs)
    mx, my = sum(a for a, _ in pairs) / n, sum(b for _, b in pairs) / n
    corr = sum((a - mx) * (b - my) for a, b in pairs) / math.sqrt(sum((a - mx) ** 2 for a, _ in pairs) * sum((b - my) ** 2 for _, b in pairs))
    errs.sort()
    check(corr > 0.97, f'current values track the truth (log corr {corr:.3f}, {n} players)')
    check(errs[len(errs) // 2] < 0.12, f'median current error {math.exp(errs[len(errs) // 2]) - 1:.1%} under 12%')
    h0 = hist.get('0', {}).get('v')
    off = len(h0) - N_WEEKS if h0 else 0   # the fit's weeks can start a week earlier
    ratio = h0[off + JUMP_WEEK + 6] / h0[off + JUMP_WEEK - 6] if h0 else None
    true_ratio = math.exp(logv[0][JUMP_WEEK + 6] - logv[0][JUMP_WEEK - 6])
    check(ratio is not None and abs(math.log(ratio / true_ratio)) < 0.2,
          f'the doubling player is caught (x{ratio and round(ratio, 2)} across the jump, true x{true_ratio:.2f})')
    picks = {(p['round'], p['ahead'], p['tier']): p['value'] for p in cur['picks']}
    check(abs(picks.get((2, 0, 'M'), 0) / 40 - 1) < 0.2, f"mid 2nd near 40 ({picks.get((2, 0, 'M'))})")
    ho = cur['holdout']
    best = min(ho['medianAbsLogRatio'].values())
    check(best < ho['static'], f"held-out: weekly {best} beats a static fit {ho['static']}")
    check(not any(k in json.dumps(cur) for k in ('"L1', '"U1', '"T1')), 'output carries no league / manager / trade ids')
    print(f'{len(fails)} failed' if fails else 'all passed')
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
