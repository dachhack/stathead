#!/usr/bin/env python3
"""Offline checks for scripts/build-pick-board.py: the board carries the
week's picks, their grading and the validation summaries, and never a field
Sleeper's payouts or pick shares can be read from (the data policy's
exception covers the lines only).

Run:  python3 scripts/test-pick-board.py
"""
import importlib.util
import json
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location('board', os.path.join(ROOT, 'scripts', 'build-pick-board.py'))
board_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(board_mod)

FORBIDDEN = {'mult', 'multNow', 'multOver', 'multUnder', 'breakeven', 'ev', 'ret', 'publicOver', 'publicOverNow',
             'picks', 'lineHistory', 'sleeper', 'game_id', 'source'}

passed, failed = 0, []


def check(name, ok, detail=None):
    global passed
    if ok:
        passed += 1
    else:
        failed.append(f'{name}: {detail}')


def pick(**kw):
    base = {'week': 8, 'player': 'A Back', 'gsis': '00-1', 'pos': 'RB', 'team': 'DAL', 'stat': 'rushYds', 'line': 20.5,
            'lean': 'under', 'pLean': 0.64, 'pRaw': 0.78, 'edge': 0.086, 'proj': 12.8, 'median': 9.7, 'flags': [],
            'recordedAt': '2026-11-01T14:11:42+00:00', 'source': 'sleeper', 'sleeper': '123', 'game_id': 'g1',
            'mult': 1.79, 'multNow': 1.8, 'multOver': 1.77, 'multUnder': 1.79, 'breakeven': 0.559, 'ev': 0.15,
            'publicOver': 0.8, 'publicOverNow': 0.83, 'picks': 40, 'lineHistory': [[1, 20.5]], 'lineNow': 19.5,
            'lineMove': -1.0}
    base.update(kw)
    return base


with tempfile.TemporaryDirectory() as tmp:
    data = os.path.join(tmp, 'public', 'data')
    os.makedirs(data)
    os.makedirs(os.path.join(tmp, 'data'))
    log = {'picks': [pick(), pick(player='B Back', team='IND', tag='call', edge=0.03),
                     pick(week=7, player='Old Pick')]}
    json.dump(log, open(os.path.join(tmp, 'data', 'pick-log.json'), 'w'))
    json.dump({'currentWeek': 8, 'playedThrough': 7, 'players': []},
              open(os.path.join(data, 'weekly-projections-2026.json'), 'w'))
    json.dump({'games': [{'week': 8, 'date': '2026-11-01T13:00:00-05:00', 'away': 'ARI', 'home': 'DAL'},
                         {'week': 8, 'date': '2026-11-01T16:05:00-05:00', 'away': 'IND', 'home': 'JAX'}]},
              open(os.path.join(data, 'schedule-2026.json'), 'w'))
    summary = {'n': 1, 'hits': 1, 'hitRate': 1.0, 'expectedHitRate': 0.6, 'rawExpectedHitRate': 0.7, 'return': 0.79, 'roi': 0.79}
    graded = {**pick(week=7, player='Old Pick'), 'actual': 9.0, 'hit': True, 'push': False, 'ret': 0.79}
    json.dump({'picks': {'graded': [graded], 'pending': 2, 'overall': summary, 'byConfidence': {'62%+': summary, '58-62%': None},
                         'byWeek': {'7': summary}, 'byTag': {'auto': summary}, 'byStat': {}, 'byMove': {},
                         'flagged': None, 'unflagged': summary, 'voided': 0}},
              open(os.path.join(data, 'weekly-projections-accuracy.json'), 'w'))

    board_mod.DATA = data
    board_mod.PICK_LOG = os.path.join(tmp, 'data', 'pick-log.json')
    b = board_mod.build(2026)

    rows = b['picks'] + b['graded']
    leaked = {k for r in rows for k in r} & FORBIDDEN
    check('no payout, pick-share or source field reaches the board', not leaked, leaked)
    check('only the current week is on the board', [p['player'] for p in b['picks']] == ['A Back', 'B Back'], b['picks'])
    check('kickoff and opponent joined from the schedule',
          b['picks'][0].get('kickoff') == '2026-11-01T13:00:00-05:00' and b['picks'][0].get('opp') == 'ARI'
          and b['picks'][0].get('home') is True, b['picks'][0])
    check('picks ordered by kickoff', b['picks'][1]['team'] == 'IND')
    check('call tag kept', b['picks'][1].get('tag') == 'call')
    check('line, lean, probability, edge kept',
          all(k in b['picks'][0] for k in ('line', 'lean', 'pLean', 'edge', 'proj', 'median', 'lineNow')), b['picks'][0])
    check('graded rows carry the result, not the return', b['graded'][0].get('hit') is True
          and b['graded'][0].get('actual') == 9.0 and 'ret' not in b['graded'][0], b['graded'][0])
    check('empty summary buckets dropped', set(b['validation']['byConfidence']) == {'62%+'}, b['validation']['byConfidence'])
    check('summaries keep hit rate, expected and ROI', b['validation']['overall'] == summary, b['validation']['overall'])
    check('method constants read from price-lines.py', b['method'].get('calShrink') == 0.5 and b['method'].get('minEdge') == 0.02,
          b['method'])
    check('week and played-through from the weekly file', b['week'] == 8 and b['playedThrough'] == 7)

# The grader's confidence buckets must not overlap (score-weekly-projections.py).
src = open(os.path.join(ROOT, 'scripts', 'score-weekly-projections.py')).read()
check('confidence buckets take the next bucket up as the ceiling',
      "hi = min((l2 for l2, _ in PICK_BUCKETS if l2 > lo), default=1.01)" in src)

print(f'{passed} passed, {len(failed)} failed')
for f in failed:
    print('  ✗', f)
sys.exit(1 if failed else 0)
