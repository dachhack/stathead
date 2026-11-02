#!/usr/bin/env python3
"""Offline checks for scripts/build-pick-bundles.py: which leans may go in a
bundle, the optimizer's rules (three games, no shared leg or player, best
expected return first), the frozen-set log, and grading a bundle from its
legs.

Run:  python3 scripts/test-pick-bundles.py
"""
import importlib.util
import json
import os
import sys
import tempfile
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location('bundles', os.path.join(ROOT, 'scripts', 'build-pick-bundles.py'))
bm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bm)

passed, failed = 0, []


def check(name, ok, detail=None):
    global passed
    if ok:
        passed += 1
    else:
        failed.append(f'{name}: {detail}')


NOW = datetime(2026, 11, 1, 14, 0, tzinfo=timezone.utc)
GAMES = {t: (g, k) for g, k, teams in (
    ('A@B', '2026-11-01T13:00:00-05:00', ('A', 'B')), ('C@D', '2026-11-01T13:00:00-05:00', ('C', 'D')),
    ('E@F', '2026-11-01T16:05:00-05:00', ('E', 'F')), ('G@H', '2026-11-01T16:25:00-05:00', ('G', 'H')),
    ('I@J', '2026-10-29T20:15:00-04:00', ('I', 'J'))) for t in teams}


def leg(player, team, p=0.6, mult=1.8, stat='rec', line=2.5, lean='under', **kw):
    return {'week': 8, 'player': player, 'gsis': f'id-{player}', 'pos': 'WR', 'team': team, 'stat': stat, 'line': line,
            'lean': lean, 'pLean': p, 'mult': mult, 'edge': round(p - 1 / mult, 3), 'flags': [],
            'recordedAt': '2026-11-01T13:00:00+00:00', **kw}


# Which leans may go in a bundle.
picks = [
    leg('a1', 'A'), leg('flag', 'B', flags=['form:x']), leg('void', 'C', void='inactive (Out)'),
    leg('thin', 'D', p=0.56, mult=1.78), leg('started', 'I'), leg('wk7', 'E', week=7),
    leg('dup', 'G', line=2.5, recordedAt='2026-10-30T00:00:00+00:00'), leg('dup', 'G', line=3.5),
]
c = bm.candidates(picks, 8, GAMES, NOW)
names = sorted((p['player'], p['line']) for p in c)
check('flagged, voided, under-edge, kicked-off and other-week leans are out',
      [n for n, _ in names] == ['a1', 'dup'], names)
check('one line per player and stat, the newest', ('dup', 3.5) in names and ('dup', 2.5) not in names, names)

# The optimizer.
pool = [leg('a1', 'A', p=0.66), leg('a2', 'A', p=0.65), leg('c1', 'C', p=0.62), leg('e1', 'E', p=0.6),
        leg('g1', 'G', p=0.59), leg('c2', 'C', p=0.58), leg('e2', 'E', p=0.57), leg('g2', 'G', p=0.57, mult=1.9),
        leg('a3', 'A', p=0.58)]
cands = bm.candidates(pool, 8, GAMES, NOW)
bundles = bm.optimize(cands, max_bundles=5)
check('3 legs each', all(len(b) == 3 for b in bundles), [len(b) for b in bundles])
check('three different games per bundle', all(len({p['_game'] for p in b}) == 3 for b in bundles))
keys = [bm.leg_key(p) for b in bundles for p in b]
check('no leg in two bundles', len(keys) == len(set(keys)), keys)
players = [p['player'] for b in bundles for p in b]
check('no player in two bundles', len(players) == len(set(players)), players)
evs = [bm.ev(b) for b in bundles]
check('best expected return first', evs == sorted(evs, reverse=True), evs)
check('the first bundle is the best of all combinations',
      {p['player'] for p in bundles[0]} == {'a1', 'c1', 'e1'} or abs(evs[0] - max(
          bm.ev(x) for x in __import__('itertools').combinations(cands, 3) if len({p['_game'] for p in x}) == 3)) < 1e-9,
      [p['player'] for p in bundles[0]])
used = {bm.leg_key(p) for b in bundles for p in b} | {p['player'] for b in bundles for p in b}
rest = [p for p in cands if bm.leg_key(p) not in used and p['player'] not in used]
check('stops only when the legs left cannot make a bundle', len(bundles) >= 2 and bm.optimize(rest) == [],
      (len(bundles), [p['player'] for p in rest]))
check('max respected', len(bm.optimize(cands, max_bundles=1)) == 1)
check('min expected return respected', bm.optimize(cands, min_ev=9.0) == [])
check('fewer than three games: no bundle', bm.optimize(bm.candidates([leg('x', 'A'), leg('y', 'C')], 8, GAMES, NOW)) == [])

row = bm.bundle_row(bundles[0])
check('a bundle row carries P(all 3), expected return and its legs',
      abs(row['pAll'] - round(bundles[0][0]['pLean'] * bundles[0][1]['pLean'] * bundles[0][2]['pLean'], 3)) < 1e-9
      and abs(row['ev'] - round(evs[0], 3)) < 1e-9 and len(row['legs']) == 3, row)

# The log: a set is appended once, and an identical re-run adds nothing.
with tempfile.TemporaryDirectory() as tmp:
    path = os.path.join(tmp, 'pick-bundles.json')
    bset = {'week': 8, 'builtAt': NOW.isoformat(), 'candidates': len(cands), 'bundles': [bm.bundle_row(b) for b in bundles]}
    check('a new set is recorded', bm.record(bset, path) is True)
    check('the same set again is not', bm.record({**bset, 'builtAt': 'later'}, path) is False)
    smaller = {**bset, 'bundles': bset['bundles'][:1]}
    check('a changed set is recorded as a new one', bm.record(smaller, path) is True)
    check('an empty set is not recorded', bm.record({**bset, 'bundles': []}, path) is False)
    check('two sets in the log', len(json.load(open(path))['sets']) == 2)

# Grading a bundle from its legs.
b = bm.bundle_row(bundles[0])
k = [l['key'] for l in b['legs']]
res = lambda d: (lambda key: d.get(key))
check('all legs hit: won', bm.bundle_results(b, res({x: {'hit': True} for x in k}))[1] == 'won')
check('a miss: lost, even with legs open', bm.bundle_results(b, res({k[0]: {'hit': False}}))[1] == 'lost')
check('legs still open: open', bm.bundle_results(b, res({k[0]: {'hit': True}}))[1] == 'open')
check('a void leg drops out', bm.bundle_results(b, res({k[0]: {'void': 'inactive'}, k[1]: {'hit': True}, k[2]: {'hit': True}}))[1] == 'won')
check('a did-not-play leg drops out',
      bm.bundle_results(b, res({k[0]: {'hit': None, 'note': 'did not play'}, k[1]: {'hit': True}, k[2]: {'hit': True}}))[1] == 'won')
check('every leg void: void', bm.bundle_results(b, res({x: {'void': 'out'} for x in k}))[1] == 'void')
legs, _ = bm.bundle_results(b, res({k[0]: {'hit': True, 'actual': 3.0, 'provisional': True}}))
check('legs carry their result', legs[0].get('actual') == 3.0 and legs[0].get('provisional') is True, legs[0])

print(f'{passed} passed, {len(failed)} failed')
for f in failed:
    print('  ✗', f)
sys.exit(1 if failed else 0)
