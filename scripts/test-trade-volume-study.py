#!/usr/bin/env python3
"""Offline test of scripts/study-trade-volume.py on a hand-built database.

40 offense players with fixed values (player k ranks k), except pid-5, who
jumps to the top in week 3. 2,000 random two-player trades over 40 weeks in
superflex dynasty leagues with no / half / full TE premium, plus trades the
study must leave out (FAAB, three teams, redraft, 1QB in the superflex count,
week 0 with no week-before rank). Checks the counts by rank against an
independent count, the week-before rank, the cohorts, unranked and IDP
players, suppression, and that no player id reaches the output.

Usage: python3 scripts/test-trade-volume-study.py
"""
from __future__ import annotations

import json
import random
import sqlite3
import subprocess
import sys
import tempfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEEK_MS = 7 * 86400 * 1000
N_WEEKS, JUMP = 40, 3
POS = {k: 'QB' if k <= 10 else 'RB' if k <= 20 else 'WR' if k <= 30 else 'TE' for k in range(1, 41)}


def main() -> None:
    fails = []

    def check(ok, msg):
        print(('  ok   ' if ok else '  FAIL ') + msg)
        if not ok:
            fails.append(msg)

    t0 = int(datetime(2025, 3, 6, tzinfo=timezone.utc).timestamp() * 1000)
    w0 = t0 - t0 % WEEK_MS
    tmp = Path(tempfile.mkdtemp())

    def value(k, wk):
        return 2000.0 if k == 5 and wk >= JUMP else 1000.0 - k

    def rank(k, wk):   # the independent count: rank on week wk's values
        order = sorted(range(1, 41), key=lambda q: -value(q, wk))
        r = order.index(k) + 1
        pr = [q for q in order if POS[q] == POS[k]].index(k) + 1
        return r, pr
    hist = {'formats': {'superflex': {f'pid-{k}': {'from': datetime.fromtimestamp(w0 / 1000, timezone.utc).date().isoformat(),
                                                   'v': [value(k, w) for w in range(N_WEEKS)]} for k in range(1, 41)}}}
    hist['formats']['superflex']['pid-99'] = {'from': hist['formats']['superflex']['pid-1']['from'], 'v': [50.0] * N_WEEKS}
    vals = {'formats': {'superflex': {'to': 'x', 'players': [{'sleeper_id': f'pid-{k}', 'pos': POS[k]} for k in range(1, 41)]
                                      + [{'sleeper_id': 'pid-99', 'pos': 'LB', 'idp': True},
                                         {'sleeper_id': 'pid-77', 'pos': 'WR'}]}}}
    (tmp / 'v.json').write_text(json.dumps(vals))
    (tmp / 'h.json').write_text(json.dumps(hist))

    db = sqlite3.connect(tmp / 'sleeper-trades.sqlite')
    db.executescript("""
      CREATE TABLE trades (id TEXT PRIMARY KEY, season INTEGER, created INTEGER, n_sides INTEGER, type TEXT,
                           sf INTEGER, tep REAL, n_players INTEGER, n_picks INTEGER, faab_total INTEGER);
      CREATE TABLE trade_assets (trade_id TEXT, kind TEXT, player_id TEXT);""")
    rng = random.Random(5)
    expect = Counter()        # (cohort, rank) -> appearances
    expect_pos = Counter()    # (position, position rank)
    trades_by = Counter()
    unranked = idp = 0
    for i in range(2000):
        wk = rng.randrange(1, N_WEEKS)
        created = w0 + wk * WEEK_MS + rng.randrange(WEEK_MS)
        tep = rng.choice([0, 0.5, 1.0])
        season = 2025 if wk < 30 else 2026
        players = rng.sample(range(1, 41), 2)
        extra = rng.random() < 0.05   # an unranked WR or an IDP player on the side
        db.execute('INSERT INTO trades VALUES (?,?,?,?,?,?,?,?,?,?)', (f'T{i}', season, created, 2, 'dynasty', 1, tep,
                                                                       len(players) + extra, 0, 0))
        tc = 'none' if tep == 0 else 'under0.75' if tep < 0.75 else '0.75plus'
        month = datetime.fromtimestamp(created / 1000, timezone.utc).month
        period = {2: 'offseason', 3: 'offseason', 4: 'offseason', 5: 'rookieDrafts', 6: 'rookieDrafts',
                  7: 'preseason', 8: 'preseason', 9: 'earlySeason', 10: 'earlySeason'}.get(month, 'lateSeason')
        for c in ('all', 'tep:' + tc, f'season:{season}', 'period:' + period):
            trades_by[c] += 1
        for k in players:
            db.execute('INSERT INTO trade_assets VALUES (?,?,?)', (f'T{i}', 'player', f'pid-{k}'))
            r, pr = rank(k, wk - 1)
            for c in ('all', 'tep:' + tc, f'season:{season}', 'period:' + period):
                expect[(c, r)] += 1
            expect_pos[(POS[k], pr)] += 1
        if extra:
            x = rng.choice(['pid-77', 'pid-99'])
            db.execute('INSERT INTO trade_assets VALUES (?,?,?)', (f'T{i}', 'player', x))
            unranked += x == 'pid-77'
            idp += x == 'pid-99'
        db.execute('INSERT INTO trade_assets VALUES (?,?,?)', (f'T{i}', 'pick', None))
    # Trades the study must leave out.
    skip = [('FAAB', dict(faab_total=5)), ('three teams', dict(n_sides=3)), ('redraft', dict(type='redraft')),
            ('1QB', dict(sf=0)), ('week 0', dict(created=w0 + 100))]
    for j, (_, over) in enumerate(skip):
        row = dict(id=f'S{j}', season=2025, created=w0 + 5 * WEEK_MS, n_sides=2, type='dynasty', sf=1, tep=0,
                   n_players=2, n_picks=0, faab_total=0)
        row.update(over)
        db.execute('INSERT INTO trades VALUES (:id,:season,:created,:n_sides,:type,:sf,:tep,:n_players,:n_picks,:faab_total)', row)
        for k in (1, 2):
            db.execute('INSERT INTO trade_assets VALUES (?,?,?)', (f'S{j}', 'player', f'pid-{k}'))
    db.commit()
    db.close()

    def run(min_cell):
        out = tmp / f'study-{min_cell}.json'
        r = subprocess.run([sys.executable, 'scripts/study-trade-volume.py', str(tmp), f'--values={tmp / "v.json"}',
                            f'--history={tmp / "h.json"}', f'--out={out}', f'--min-cell={min_cell}'],
                           cwd=ROOT, capture_output=True, text=True)
        check(r.returncode == 0, f'study runs (min cell {min_cell}) {r.stderr[-600:]}')
        return json.loads(out.read_text()), out.read_text()

    res, _ = run(1)
    sf = res['formats']['superflex']['cohorts']
    allc = sf['all']['all']
    check(allc['trades'] == 2000, f"left out FAAB, 3-team, redraft, 1QB and week-0 trades: {allc['trades']} trades")
    got = {int(r['ranks']): r['n'] or 0 for r in allc['overall'] if r['ranks'].isdigit()}
    want = {r: expect[('all', r)] for r in range(1, 21)}
    check(got == want, f'ranks 1-20 match an independent count with the week-before rank ({sum(want.values())} appearances)')
    g21 = next(r['n'] for r in allc['overall'] if r['ranks'] == '21-25')
    check(g21 == sum(expect[('all', r)] for r in range(21, 26)), f'group 21-25: {g21}')
    # pid-5 jumped in week JUMP: trades in week JUMP+1 on see him at rank 1,
    # trades in week JUMP still at rank 5 (the week before).
    check(expect[('all', 1)] > 0 and got[1] == expect[('all', 1)], 'rank 1 counts the jump only from the week after')
    for p in ('QB', 'TE'):
        rows = sf['all']['all']['positions'][p]['byPositionRank']
        check(rows[0]['n'] == sum(expect_pos[(p, r)] for r in range(1, 6)), f'{p}1-5 by position rank: {rows[0]["n"]}')
    unr = next(r['n'] for r in allc['overall'] if r['ranks'] == 'unranked') or 0
    check(unr == unranked + idp and (allc['otherPlayers'] or 0) == idp,
          f'unranked {unr} = {unranked} unranked WRs + {idp} IDP players (IDP kept out of the positions)')
    check(allc['positions']['WR']['byPositionRank'][-1]['n'] == (unranked or None), 'the unranked WR counts as an unranked WR')
    tep = sf['tep']
    check(sum(tep[c]['trades'] for c in tep) == 2000 and all(tep[c]['trades'] == trades_by['tep:' + c] for c in tep),
          f"TE premium cohorts: {({c: tep[c]['trades'] for c in tep})}")
    check(all(sf['period'][c]['trades'] == trades_by['period:' + c] for c in sf['period']) and len(sf['period']) >= 4,
          f"periods: {({c: sf['period'][c]['trades'] for c in sf['period']})}")
    check(all(sf['season'][c]['trades'] == trades_by[f'season:{c}'] for c in sf['season']), 'season cohorts')
    one = {int(r['ranks']): r['n'] or 0 for r in tep['0.75plus']['overall'] if r['ranks'].isdigit()}
    check(one == {r: expect[('tep:0.75plus', r)] for r in range(1, 21)}, 'a cohort\'s ranks match its own count')
    shares = [r['share'] for r in allc['overall'] if r['share'] is not None]
    check(abs(sum(shares) - 100) < 0.5, f'overall shares add up to 100 ({sum(shares):.2f})')
    top12 = sum(expect[('all', r)] for r in range(1, 13)) / 12
    nxt = sum(expect[('all', r)] for r in range(25, 49)) / 24   # per rank slot (only 40 players here)
    check(allc['summary']['top12VsRanks25to48'] == round(top12 / nxt, 3),
          f"top 12 against ranks 25-48 per slot: {allc['summary']['top12VsRanks25to48']} (by hand {top12 / nxt:.3f})")

    res, text = run(60)
    c = res['formats']['superflex']['cohorts']['all']['all']
    small = [r for r in c['overall'] if r['n'] is not None and r['n'] < 60]
    check(not small and any(r['n'] is None for r in c['overall']), 'cells under the minimum are suppressed (null)')
    check('pid-' not in text and '"T1' not in text and '"S0' not in text, 'no player or trade id in the output')
    print(f'{len(fails)} failed' if fails else 'all passed')
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
