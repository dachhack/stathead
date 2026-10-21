#!/usr/bin/env python3
"""Offline test of scripts/fit-player-values.py on synthetic trades.

300 players with KNOWN values that drift week to week (one doubles halfway),
and two pick classes (mid 1st = 100, mid 2nd = 40), traded across 200
superflex dynasty leagues for 40 weeks: each trade sends one player for 1-3
assets worth about the same (log-normal noise). Players 200-259 are TEs and
260-299 QBs; a quarter of the leagues pay a full TE premium (TEs worth x1.3
there), a quarter 6-point passing TDs (QBs x1.2), a quarter both with a half
TE premium (x1.15). Shards -> lite build -> fit, then checks that the fit
recovers current values, the jump, the pick scale and the scoring factors,
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
TE_IDS, QB_IDS = range(200, 260), range(260, 300)
TRUE_FACTOR = {'tePremiumUnder0.75': 1.15, 'tePremium0.75Plus': 1.3, 'passTd6': 1.2}
CUT = 20   # truncation test: weeks 0..CUT kept


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
            # Planted trends over the last 8 weeks: 1-10 rise, 11-20 fall, 5%/week.
            if w >= N_WEEKS - 8 and 1 <= p <= 20:
                x += math.log(1.05) if p <= 10 else -math.log(1.05)
            path.append(x)
        logv.append(path)
    pick_val = {1: 100.0, 2: 40.0}
    tmp = Path(tempfile.mkdtemp())
    (tmp / 'shards').mkdir()
    leagues, trades = [], []
    for li in range(N_LEAGUES):
        tep, pass_td = ((0, 4), (1.0, 4), (0, 6), (0.5, 6))[li % 4]
        fmt = {'type': 'dynasty', 'teams': TEAMS, 'sf': True, 'tep': tep, 'passTd': pass_td, 'ppr': 1, 'faabBudget': 0,
               'bestBall': False}

        def eff(q, wk, tep=tep, pass_td=pass_td):
            """Player q's true value in this league's scoring."""
            f = (TRUE_FACTOR['tePremium0.75Plus'] if tep >= 0.75 else TRUE_FACTOR['tePremiumUnder0.75'] if tep > 0 else 1) \
                if q in TE_IDS else (TRUE_FACTOR['passTd6'] if pass_td == 6 else 1) if q in QB_IDS else 1
            return math.exp(logv[q][wk]) * f
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
            # Movers get traded more, as real ones do: the planted trend
            # players are four times as likely to be the player sent.
            p = rng.randrange(1, 21) if rng.random() < 0.2 else rng.randrange(N_PLAYERS)
            # Match side B to side A's TRUE value: the leftover mismatch is the
            # trade's noise. (Matching a noisy target instead biases whichever
            # asset is compared with the noise-inflated, mostly cheap players.)
            target = eff(p, wk)
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
                tot = sum(pick_val[x[1]] if x[0] == 'k' else eff(x[1], wk) for x in assets)
                if best is None or abs(math.log(tot / target)) < best[0]:
                    best = (abs(math.log(tot / target)), assets)
            # A trade the random bundles cannot match closely is skipped, not
            # clamped: clamping the cheapest and dearest players' trades
            # pulled their premium-league prices toward 1 (x1.22 for a planted
            # x1.3 TE premium).
            if best[0] > 0.15:
                continue
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
    # The same crawl cut off after week CUT: as-of values up to CUT must not
    # depend on anything later.
    cut_dir = Path(tempfile.mkdtemp())
    (cut_dir / 'shards').mkdir()
    cut_ms = int((START + timedelta(weeks=CUT + 1)).timestamp() * 1000)
    for kind, rows in (('leagues', leagues), ('trades', [t for t in trades if t['created'] < cut_ms])):
        with gzip.open(cut_dir / 'shards' / f'20260101T000000-{kind}.jsonl.gz', 'wt') as f:
            for r in rows:
                f.write(json.dumps(r) + '\n')

    positions = tmp / 'positions.json'
    # Every synthetic player gets a position: the fit also reads the real
    # crosswalk, where some of these ids are real QBs and TEs.
    positions.write_text(json.dumps({str(q): 'TE' if q in TE_IDS else 'QB' if q in QB_IDS else 'WR' for q in range(N_PLAYERS)}))
    pos_arg = f'--positions={positions}'
    fails = []

    def check(ok, msg):
        print(('  ok   ' if ok else '  FAIL ') + msg)
        if not ok:
            fails.append(msg)

    run = lambda *a: subprocess.run([sys.executable, *a], cwd=ROOT, capture_output=True, text=True)
    r = run('scripts/build-sleeper-trade-db.py', str(tmp), '--lite')
    check(r.returncode == 0, f'lite build {r.stderr[-300:]}')
    r = run('scripts/fit-player-values.py', str(tmp), f'--outdir={tmp}', pos_arg)
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
    sc = cur.get('scoring', {})
    for label, true_f in TRUE_FACTOR.items():
        got = sc.get(label, {}).get('factor')
        check(got is not None and abs(math.log(got / true_f)) < 0.07, f'scoring factor {label} recovered ({got} vs {true_f})')
    te_rows = [r for r in cur['players'] if int(r['sleeper_id']) in TE_IDS and r['tradesAll'] >= 40]
    te_err = sorted(abs(math.log(r['value'] / (100 * math.exp(logv[int(r['sleeper_id'])][last]) / pick_val[1]))) for r in te_rows)
    check(te_err and te_err[len(te_err) // 2] < 0.12 and all('scoring' in r for r in te_rows),
          f'TE values are the no-premium values (median error {te_err and math.exp(te_err[len(te_err) // 2]) - 1:.1%}), with premium versions')
    ho = cur['holdout']
    best = min(ho['medianAbsLogRatio'].values())
    check(best < ho['static'], f"held-out: weekly {best} beats a static fit {ho['static']}")
    check(not any(k in json.dumps(cur) for k in ('"L1', '"U1', '"T1')), 'output carries no league / manager / trade ids')

    # Meta stats.
    rows = {r['sleeper_id']: r for r in cur['players']}
    up = [rows[str(p)] for p in range(1, 11) if str(p) in rows]
    down = [rows[str(p)] for p in range(11, 21) if str(p) in rows]
    vel_ok = sum(1 for r in up if r.get('velocity', 0) > 0.02) + sum(1 for r in down if r.get('velocity', 0) < -0.02)
    check(vel_ok >= 0.8 * (len(up) + len(down)), f'velocity finds the planted 5%/week trends ({vel_ok}/{len(up) + len(down)})')
    lab = sum(1 for r in up if r.get('trend') == 'rising') + sum(1 for r in down if r.get('trend') == 'falling')
    # The label is deliberately strict (a 4-week move past twice four weeks of
    # ordinary noise): it should be rarely wrong, and catch about half of the
    # planted trends; velocity is the continuous signal. A looser threshold
    # (1.5) caught one more planted trend and quadrupled the false labels.
    # (7-10 of 20 across synthetic draws; 0.35 leaves room for one draw's luck.)
    check(lab >= 0.35 * (len(up) + len(down)), f'trend labels a third to half of the planted trends ({lab}/{len(up) + len(down)})')
    flat = [r for r in cur['players'] if int(r['sleeper_id']) > 20 and r.get('trend')]
    false = sum(1 for r in flat if r['trend'] != 'flat')
    check(false <= 0.06 * len(flat), f'few trend labels on random-walk players ({false}/{len(flat)})')
    cov = [rows[str(p)] for p in range(N_PLAYERS) if str(p) in rows and 'ciLow' in rows[str(p)]]
    inside = sum(1 for r in cov if r['ciLow'] <= 100 * math.exp(logv[int(r['sleeper_id'])][last]) / pick_val[1] * 1.0 <= r['ciHigh'])
    check(0.8 <= inside / len(cov) <= 0.98, f'90% ranges cover the true value {inside}/{len(cov)} ({inside / len(cov):.0%})')
    ranked = sorted(r['rank'] for r in cur['players'] if 'rank' in r)
    check(ranked == list(range(1, len(ranked) + 1)) and not any('rank' in r for r in cur['players'] if r.get('idp')),
          f'ranks run 1..{len(ranked)} over offense only')

    # As of: no look-ahead. The doubling player's value must not rise before
    # the jump (the smoothed history did), and the cut-off crawl must give the
    # same values through week CUT. Same lambda for both runs, so only the
    # data differs.
    def at(h, week):
        """A history's value in the given generator week (None outside it)."""
        if not h:
            return None
        i = (START + timedelta(weeks=week) - datetime.fromisoformat(h['from']).replace(tzinfo=timezone.utc)).days // 7
        return h['v'][i] if 0 <= i < len(h['v']) else None
    pre = at(hist['0'], JUMP_WEEK - 1) / at(hist['0'], JUMP_WEEK - 5)
    true_pre = math.exp(logv[0][JUMP_WEEK - 1] - logv[0][JUMP_WEEK - 5])
    check(abs(math.log(pre / true_pre)) < 0.1, f'no rise before the jump (x{pre:.2f} over 4 weeks before it, true x{true_pre:.2f})')
    nw = cur.get('nextWeek', {})
    check(nw.get('asOfError') is not None and nw['asOfError'] < ho['static'],
          f"next-week trades priced out of sample ({nw.get('asOfError')}) beat a static fit ({ho['static']})")
    lam = f"--lambdas={cur['lambda']:g}"
    for dd in (tmp, cut_dir):
        r = run('scripts/build-sleeper-trade-db.py', str(dd), '--lite') if dd == cut_dir else r
        r = run('scripts/fit-player-values.py', str(dd), f'--outdir={dd}', lam, '--history-min=20', pos_arg,
                f'--state={dd}/asof-state.npz')
        check(r.returncode == 0, f'fit at lambda {cur["lambda"]:g} ({dd.name}) {r.stderr[-300:]}')
    full = json.loads((tmp / 'player-trade-values-history.json').read_text())['formats']['superflex']
    part = json.loads((cut_dir / 'player-trade-values-history.json').read_text())['formats']['superflex']
    diffs = []
    for pid, h in part.items():
        if pid in full:
            for wk in (CUT - 8, CUT - 2, CUT):
                a, b = at(full[pid], wk), at(part[pid], wk)
                if a and b:
                    diffs.append(abs(math.log(a / b)))
    diffs.sort()
    med = diffs[len(diffs) // 2] if diffs else None
    check(med is not None and med < 0.03, f'values through week {CUT} ignore later trades (median change {(math.exp(med) - 1) if med is not None else float("nan"):.2%} on {len(diffs)} player-weeks)')

    # Incremental: resume the full crawl's as-of pass from the cut-off run's
    # saved state. It must match the from-scratch pass on the full crawl.
    inc = Path(tempfile.mkdtemp())
    (inc / 'asof-state.npz').write_bytes((cut_dir / 'asof-state.npz').read_bytes())
    r = run('scripts/fit-player-values.py', str(tmp), f'--outdir={inc}', lam, '--history-min=20', pos_arg,
            f'--state={inc}/asof-state.npz')
    check(r.returncode == 0 and 'resuming the as-of pass' in r.stdout, f'incremental run resumes from saved state {r.stderr[-300:]}')
    inc_cur = json.loads((inc / 'player-trade-values.json').read_text())['formats']['superflex']
    inc_hist = json.loads((inc / 'player-trade-values-history.json').read_text())['formats']['superflex']
    ref_cur = {p['sleeper_id']: p['value'] for p in json.loads((tmp / 'player-trade-values.json').read_text())['formats']['superflex']['players']}
    d_now = sorted(abs(math.log(p['value'] / ref_cur[p['sleeper_id']])) for p in inc_cur['players'] if p['sleeper_id'] in ref_cur)
    d_old = sorted(abs(math.log(at(inc_hist[k], CUT - 6) / at(full[k], CUT - 6)))
                   for k in inc_hist if k in full and at(inc_hist[k], CUT - 6) and at(full[k], CUT - 6))
    check(inc_cur['mode'] == 'incremental' and d_now and d_now[len(d_now) // 2] < 0.005 and d_old and d_old[-1] < 0.001,
          f"resumed values match a from-scratch pass (current median {d_now and d_now[len(d_now) // 2]:.4f}, "
          f"week {CUT - 6} max {d_old and d_old[-1]:.4f}, mode {inc_cur['mode']})")

    # Trimming: loading only the trades the as-of pass can reach must not
    # change what it publishes. Short history and burn-in make the trim bite
    # on this 41-week crawl (it starts loading at week 19).
    trim = {}
    for tag, extra in (('trimmed', []), ('all', ['--all-weeks'])):
        o = Path(tempfile.mkdtemp())
        r = run('scripts/fit-player-values.py', str(tmp), f'--outdir={o}', lam, '--history-weeks=4', '--burn-in=4',
                '--history-min=20', pos_arg, *extra)
        trim[tag] = (r, o)
    r_t, o_t = trim['trimmed']
    check(r_t.returncode == 0 and 'trades from' in r_t.stdout, f'trimmed run loads from a cutoff {r_t.stderr[-300:]}')
    a = {p['sleeper_id']: p['value'] for p in json.loads((o_t / 'player-trade-values.json').read_text())['formats']['superflex']['players']}
    b = {p['sleeper_id']: p['value'] for p in json.loads((trim['all'][1] / 'player-trade-values.json').read_text())['formats']['superflex']['players']}
    dd = sorted(abs(math.log(a[k] / b[k])) for k in a if k in b)
    check(dd and dd[-1] < 1e-3, f'trimming leaves published values unchanged (max change {dd and dd[-1]:.5f} on {len(dd)} players)')
    print(f'{len(fails)} failed' if fails else 'all passed')
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
