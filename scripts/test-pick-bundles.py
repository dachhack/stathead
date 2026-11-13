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
c_out = bm.candidates(picks, 8, GAMES, NOW, out={'id-a1'})
check('a player unavailable now is out, whatever his flags said when priced', [p['player'] for p in c_out] == ['dup'], c_out)
with tempfile.TemporaryDirectory() as tmp:
    json.dump({'players': [{'gsis': 'g-ir', 'status': 'RES'}, {'gsis': 'g-q', 'status': 'ACT', 'inj': {'status': 'Questionable'}},
                           {'gsis': 'g-slp', 'status': 'ACT', 'slp': {'status': 'IR'}}, {'gsis': 'g-ok', 'status': 'ACT'}]},
              open(os.path.join(tmp, 'weekly-projections-2026.json'), 'w'))
    real, bm.DATA = bm.DATA, tmp
    try:
        check('unavailable: not active, or on the injury report', bm.unavailable(2026) == {'g-ir', 'g-q', 'g-slp'}, bm.unavailable(2026))
    finally:
        bm.DATA = real

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

# Re-pricing at build time (reprice): a stand-in Pricer returns today's price.
class FakePricer:
    def __init__(self, now):
        self.now = now
    def price(self, spec):
        return self.now.get(spec['name'], {'error': 'not in the weekly feed'})
legs = [leg('keep', 'A', p=0.60), leg('flip', 'C'), leg('flag', 'E'), leg('thin', 'G'), leg('gone', 'A', stat='recYds'),
        leg('moved', 'C', stat='recYds')]
today = {'keep': {'lean': 'under', 'pLean': 0.62, 'pRaw': 0.74, 'edge': 0.058, 'mult': 1.8, 'flags': [], 'qbOut': 0.85},
         'flip': {'lean': 'over', 'pLean': 0.55, 'edge': 0.03, 'mult': 1.8, 'flags': []},
         'flag': {'lean': 'under', 'pLean': 0.62, 'edge': 0.06, 'mult': 1.8, 'flags': ['status:Questionable']},
         'thin': {'lean': 'under', 'pLean': 0.56, 'edge': 0.004, 'mult': 1.8, 'flags': []},
         'moved': {'lean': 'under', 'pLean': 0.60, 'edge': 0.04, 'mult': 1.8, 'flags': ['moved:-1.0 away since 11-02']}}
kept, dropped = bm.reprice(legs, 2026, 8, NOW, pricer=FakePricer(today))
why = {c['player']: w for c, w in dropped}
check('a leg that still holds is kept with today\'s probability',
      [c['player'] for c in kept] == ['keep', 'moved'] and kept[0]['pLean'] == 0.62 and kept[0]['pLeanRecorded'] == 0.60
      and kept[0]['qbOut'] == 0.85, kept)
check('a flipped lean is dropped', why.get('flip') == 'lean flipped', why)
check('a new guardrail flag drops the leg', (why.get('flag') or '').startswith('flag status'), why)
check('an edge under the minimum drops the leg', (why.get('thin') or '').startswith('edge'), why)
check('a leg the feed no longer prices is dropped', why.get('gone') == 'not in the weekly feed', why)
check('a line-move flag alone does not drop a leg', 'moved' not in why, why)

# Against Sleeper's live board: pulled or moved lines drop, the rest price at
# today's payouts and carry the line's team (for the team guardrail).
class SpyPricer(FakePricer):
    seen = {}
    def price(self, spec):
        SpyPricer.seen[spec['name']] = spec
        return super().price(spec)
legs = [leg('keep', 'A', sleeper='1'), leg('pulled', 'C', sleeper='2'), leg('shifted', 'E', sleeper='3'),
        leg('typed', 'G', source='typed')]
board = {('1', 'rec'): {'line': 2.5, 'multOver': 1.7, 'multUnder': 2.05, 'team': 'A'},
         ('3', 'rec'): {'line': 3.5, 'multOver': 1.8, 'multUnder': 1.8, 'team': 'E'}}
today = {'keep': {'lean': 'under', 'pLean': 0.62, 'edge': 0.13, 'mult': 2.05, 'flags': []},
         'typed': {'lean': 'under', 'pLean': 0.6, 'edge': 0.04, 'mult': 1.8, 'flags': []}}
kept, dropped = bm.reprice(legs, 2026, 8, NOW, pricer=SpyPricer(today), live=board)
why = {c['player']: w for c, w in dropped}
check('a line pulled from the board is dropped', why.get('pulled') == 'line off the board', why)
check('a line that moved is dropped', why.get('shifted') == 'line moved 2.5 -> 3.5', why)
check("a leg on the board is priced at today's payouts and team",
      SpyPricer.seen.get('keep', {}).get('multUnder') == 2.05 and SpyPricer.seen['keep'].get('team') == 'A'
      and 'keep' in [c['player'] for c in kept], SpyPricer.seen.get('keep'))
check('a typed line is not looked up on the Sleeper board', 'typed' in [c['player'] for c in kept], why)

# No live board, no set: build() returns an error instead of a stale set.
real_live = bm.live_lines
def broken(season, slate_path=None):
    raise RuntimeError('403')
bm.live_lines = broken
real_cands, real_unav = bm.candidates, bm.unavailable
bm.candidates = lambda *a, **k: [leg('keep', 'A', sleeper='1')]
bm.unavailable = lambda season: set()
try:
    out = bm.build(2026, week=8, now=NOW)
finally:
    bm.live_lines, bm.candidates, bm.unavailable = real_live, real_cands, real_unav
check('an unreadable board builds no bundles', out['bundles'] == [] and '403' in (out.get('error') or ''), out)

print(f'{passed} passed, {len(failed)} failed')
for f in failed:
    print('  ✗', f)
sys.exit(1 if failed else 0)
