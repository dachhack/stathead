#!/usr/bin/env python3
"""Offline checks for scripts/build-pick-board.py: the board carries the
week's picks, their grading and the validation summaries, and never a field
Sleeper's payouts or pick shares can be read from (the data policy's
exception covers the lines only).

Run:  python3 scripts/test-pick-board.py
"""
import csv
import gzip
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

    # Box scores: DAL's week-8 game is final (A Back ran for 14); IND's is not.
    cols = ['player_id', 'season_type', 'week', 'team', 'position', 'carries', 'rushing_yards']
    with gzip.open(os.path.join(data, 'player_stats_2026.csv.gz'), 'wt', newline='') as fh:
        w = csv.writer(fh)
        w.writerow(cols)
        w.writerow(['00-1', 'REG', '8', 'DAL', 'RB', '7', '14'])
        w.writerow(['00-9', 'REG', '8', 'ARI', 'RB', '12', '60'])
        w.writerow(['00-1', 'REG', '7', 'DAL', 'RB', '9', '40'])

    board_mod.DATA = data
    board_mod.PICK_LOG = os.path.join(tmp, 'data', 'pick-log.json')
    b = board_mod.build(2026)

    rows = b['picks'] + b['graded'] + [l for g in (b.get('gradedBundles') or []) for l in g['legs']] \
        + [l for s in (b.get('bundles') or []) for x in s['bundles'] for l in x['legs']]
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
    check('method constants read from price-lines.py', b['method'].get('calShrink') == 0.5 and b['method'].get('calCap') == 0.62 and b['method'].get('minEdge') == 0.02,
          b['method'])
    check('week and played-through from the weekly file', b['week'] == 8 and b['playedThrough'] == 7)
    a, bb = b['picks'][0], b['picks'][1]
    check('a pick whose game is final gets an unofficial result',
          a.get('provisional') is True and a.get('actual') == 14.0 and a.get('hit') is True, a)
    check('a pick whose game is not final has no result', 'provisional' not in bb and 'hit' not in bb, bb)
    check("this week's running record", b['thisWeek'] == {'n': 1, 'hits': 1, 'hitRate': 1.0, 'expectedHitRate': 0.64,
                                                         'calls': 0, 'callHits': 0}, b['thisWeek'])
    leaked = {k for r in b['picks'] for k in r} & FORBIDDEN
    check('unofficial results add no payout field', not leaked, leaked)

# The grader's confidence buckets must not overlap (score-weekly-projections.py).
src = open(os.path.join(ROOT, 'scripts', 'score-weekly-projections.py')).read()
check('confidence buckets take the next bucket up as the ceiling',
      "hi = min((l2 for l2, _ in PICK_BUCKETS if l2 > lo), default=1.01)" in src)

# Bundle record: a bundle a later set replaced before its first game counts
# once, not again in every set that re-recorded its legs.
kicks = {'BUF': '2026-11-06T00:15:00+00:00', 'DAL': '2026-11-09T18:00:00+00:00', 'NYG': '2026-11-09T18:00:00+00:00'}
leg = lambda t: {'team': t}
sets = [
    {'week': 9, 'builtAt': '2026-11-05T16:48:00+00:00', 'bundles': [{'legs': [leg('BUF'), leg('DAL')]},   # TNF leg: in force
                                                                    {'legs': [leg('DAL'), leg('NYG')]}]},  # replaced Sat
    {'week': 9, 'builtAt': '2026-11-08T18:00:00+00:00', 'bundles': [{'legs': [leg('DAL'), leg('NYG')]}]},
    {'week': 10, 'builtAt': '2026-11-12T22:00:00+00:00', 'bundles': [{'legs': [leg('DAL')]}]},           # other week: kept
]
gone = board_mod.superseded_bundles(sets, lambda w, t: kicks.get(t))
check('a bundle replaced before its first kickoff is superseded', gone == {(0, 1)}, gone)
check('a bundle whose first game started before the next set stays counted', (0, 0) not in gone, gone)

# Bundle validation report: hit rate against the model, return at the legs'
# payouts, a void leg dropping out, and the legs against their own chance.
L = lambda hit, p=0.6, mult=2.0, **kw: {'hit': hit, 'pLean': p, 'mult': mult, **kw}
rep = board_mod.bundle_report([
    (9, {'status': 'won', 'ev': 0.6, 'legs': [L(True), L(True), L(True)]}),                 # 2^3 - 1 = +7
    (9, {'status': 'lost', 'ev': 0.3, 'legs': [L(True), L(False), L(True)]}),               # -1
    (10, {'status': 'won', 'ev': 0.1, 'legs': [L(True), L(True), L(None, void='out')]}),    # 2 live legs: +3
])
check('bundle report: record against the model',
      rep['overall']['n'] == 3 and rep['overall']['hits'] == 2
      and rep['overall']['expectedHitRate'] == round((0.216 + 0.216 + 0.36) / 3, 3), rep['overall'])
check('bundle report: return at the live legs\' payouts', rep['overall']['return'] == 9.0, rep['overall'])
check('bundle report: by week and by expected return',
      set(rep['byWeek']) == {'9', '10'} and list(rep['byEv']) == ['+50% or more', '+25% to +50%', 'under +25%'], rep)
check('bundle report: the void leg is not graded as a leg', rep['legs']['n'] == 8 and rep['legs']['hits'] == 7, rep['legs'])
check('bundle report: nothing settled, no report', board_mod.bundle_report([]) is None)

# A bundle leg takes its own week's result, not a twin's from another week.
with tempfile.TemporaryDirectory() as tmp:
    bm = board_mod.bundles_mod()
    bm.BUNDLE_LOG = os.path.join(tmp, 'pick-bundles.json')
    lg = {'player': 'D Q', 'gsis': '00-7', 'team': 'DAL', 'stat': 'passTD', 'line': 1.5, 'lean': 'under'}
    lg['key'] = bm.leg_key(lg)
    json.dump({'sets': [{'week': 10, 'builtAt': '2026-11-12T22:00:00+00:00', 'bundles': [{'pAll': 0.2, 'ev': 0.1, 'legs': [lg]}]}]},
              open(bm.BUNDLE_LOG, 'w'))
    real = board_mod.bundles_mod
    board_mod.bundles_mod = lambda: bm
    try:
        sets_, rec_, _ = board_mod.bundle_board(10, [], [{**lg, 'week': 9, 'hit': False, 'actual': 3.0}])
    finally:
        board_mod.bundles_mod = real
    check("a week-10 leg ignores the same line's week-9 result", sets_ and sets_[0]['bundles'][0]['status'] == 'open', sets_)

# Leg record: a lean re-recorded as the line moved counts once (score-weekly-projections.py).
sspec = importlib.util.spec_from_file_location('scorer', os.path.join(ROOT, 'scripts', 'score-weekly-projections.py'))
try:
    scorer = importlib.util.module_from_spec(sspec)
    sspec.loader.exec_module(scorer)
except ImportError as e:   # numpy / pandas absent: the grader is not importable here
    scorer = None
    print(f'  (skipped grader dedupe check: {e})')
if scorer:
    with tempfile.TemporaryDirectory() as tmp:
        rec = lambda line, at, **kw: {'week': 9, 'player': 'J Price', 'gsis': '00-9', 'stat': 'rushRecYds', 'line': line,
                                      'lean': 'under', 'pLean': 0.6, 'mult': 1.8, 'recordedAt': at, **kw}
        scorer.PICK_LOG = os.path.join(tmp, 'pick-log.json')
        json.dump({'picks': [rec(62.5, '2026-11-05T16:00:00+00:00'), rec(65.5, '2026-11-06T16:00:00+00:00'),
                             rec(69.5, '2026-11-08T16:00:00+00:00'),
                             {**rec(20.5, '2026-11-05T16:00:00+00:00'), 'stat': 'rec', 'lean': 'over'}]},
                  open(scorer.PICK_LOG, 'w'))
        g = scorer.grade_picks({('00-9', 9): {'rushYds': 50.0, 'recYds': 28.0, 'rec': 3.0}}, 9)
        sup = [r['line'] for r in g['graded'] if r.get('superseded')]
        check('older recordings of the same player-stat-week are superseded', sorted(sup) == [62.5, 65.5], sup)
        check('the record counts one result per player-stat-week', g['overall']['n'] == 2, g['overall'])
        check('superseded count reported', g['superseded'] == 2, g.get('superseded'))

print(f'{passed} passed, {len(failed)} failed')
for f in failed:
    print('  ✗', f)
sys.exit(1 if failed else 0)
