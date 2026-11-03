#!/usr/bin/env python3
"""Offline checks for the QB-room pass in scripts/build-weekly-projections.py
(qb_room_check): a team with every QB ruled out keeps one whose Out is not an
injury, flags the room when every Out is an injury, and backups' passYdsPG is
shrunk toward the emergency-starter average.

Run:  python3 scripts/test-qb-room.py
"""
import copy
import importlib.util
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location('bwp', os.path.join(ROOT, 'scripts', 'build-weekly-projections.py'))
bwp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bwp)

passed, failed = 0, []


def check(name, ok, detail=None):
    global passed
    if ok:
        passed += 1
    else:
        failed.append(f'{name}: {detail}')


W = 9


def qb(name, depth, slp=None, reason=None, backup=None, gp=8, inj=None, active=True, gsis=None, passYdsPG=200.0):
    p = {'name': name, 'pos': 'QB', 'team': 'BAL', 'depth': depth, 'gp': gp, 'active': active, 'gsis': gsis or name,
         'backup': depth >= 2 if backup is None else backup, 'passYdsPG': passYdsPG}
    if slp:
        p['slp'] = {'status': slp, 'week': W, **({'reason': reason} if reason else {})}
    if inj:
        p['inj'] = {'status': inj, 'week': W}
    return p


def baltimore():
    return [qb('Huntley', 1, 'Out', 'Toe', passYdsPG=191.0), qb('Fagnano', 2, 'Out', "Coach's Decision", gp=2.3, passYdsPG=210.3),
            qb('Jackson', 3, 'Out', 'Thumb'), qb('Thompson', 4, active=False)]


starts = {'Fagnano': [(8, 21.0, 91.0)], 'Huntley': [(5, 32, 201), (6, 31, 165), (7, 34, 298)]}

# Baltimore, week 9: every QB out; the coach's decision is waived.
ps = baltimore()
bwp.qb_room_check(ps, W, starts)
by = {p['name']: p for p in ps}
check('the non-injury Out is waived', 'slp' not in by['Fagnano'] and by['Fagnano']['slpWaived']['reason'] == "Coach's Decision",
      by['Fagnano'])
check('injury Outs stand', by['Huntley']['slp']['status'] == 'Out' and by['Jackson']['slp']['status'] == 'Out')
check('no qbRoomOut when a QB is kept', not any(p.get('qbRoomOut') for p in ps))
check('the kept QB is no longer ruled out', not bwp.ruled_out(by['Fagnano'], W))

# Every Out an injury: nothing waived, the room is flagged.
ps = baltimore()
ps[1]['slp']['reason'] = 'Ankle'
bwp.qb_room_check(ps, W, starts)
check('all injury Outs: nothing waived', all('slp' in p for p in ps if p['active']), ps)
check('all injury Outs: the room is flagged', all(p.get('qbRoomOut') for p in ps if p['active']))

# A healthy QB left: nothing changes.
ps = baltimore()
del ps[2]['slp']
before = copy.deepcopy(ps)
bwp.qb_room_check(ps, W, {})
check('a healthy QB left: no waiver, no flag',
      all(a.get('slp') == b.get('slp') for a, b in zip(ps, before)) and not any(p.get('qbRoomOut') or p.get('slpWaived') for p in ps))

# The official report or a game-day inactive outranks a waivable Sleeper reason.
ps = baltimore()
ps[1]['inj'] = {'status': 'Out', 'week': W}
bwp.qb_room_check(ps, W, starts)
check('an official Out is never waived', 'slp' in ps[1] and all(p.get('qbRoomOut') for p in ps if p['active']), ps[1])
ps = baltimore()
ps[1]['gd'] = {'call': 'inactive', 'week': W}
bwp.qb_room_check(ps, W, starts)
check('a game-day inactive is never waived', 'slp' in ps[1], ps[1])

# Last week's Out does not count as this week's.
ps = baltimore()
for p in ps:
    if 'slp' in p:
        p['slp']['week'] = W - 1
bwp.qb_room_check(ps, W, starts)
check("last week's Outs do not trigger the check", not any(p.get('slpWaived') or p.get('qbRoomOut') for p in ps))

# Two waivable QBs: the one who threw most recently plays.
ps = [qb('A', 1, 'Out', 'Toe'), qb('B', 2, 'Out', "Coach's Decision"), qb('C', 3, 'Out', 'Not Injury Related')]
bwp.qb_room_check(ps, W, {'B': [(5, 20, 150)], 'C': [(8, 25, 180)]})
check('the most recent passer is kept', ps[2].get('slpWaived') and 'slp' in ps[1], [p.get('slpWaived') for p in ps])

# The backup shrink.
ps = baltimore()
bwp.qb_room_check(ps, W, starts)
by = {p['name']: p for p in ps}
exp = round((1 * 91.0 + bwp.EMERGENCY_QB_K * bwp.EMERGENCY_QB_YDS) / (1 + bwp.EMERGENCY_QB_K), 1)
check("a backup's passYdsPG is his starts shrunk toward the emergency average", by['Fagnano']['passYdsPG'] == exp,
      (by['Fagnano']['passYdsPG'], exp))
check('a backup with no starts gets the emergency average', by['Jackson']['passYdsPG'] == bwp.EMERGENCY_QB_YDS)
check("a starter's passYdsPG is left alone", by['Huntley']['passYdsPG'] == 191.0)

print(f'{passed} passed, {len(failed)} failed')
for f in failed:
    print('  ✗', f)
sys.exit(1 if failed else 0)
