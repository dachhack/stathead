#!/usr/bin/env python3
"""Offline checks for the Sleeper slate reader in scripts/price-lines.py:
sleeper_slate() parses the lines endpoint's markets, and check_slate() fails
loudly when the undocumented endpoint goes missing or changes shape
(docs/sleeper-lines-api.md), without tripping on an off week.

Run:  python3 scripts/test-sleeper-slate.py
"""
import copy
import importlib.util
import json
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location('pl', os.path.join(ROOT, 'scripts', 'price-lines.py'))
pl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pl)

passed, failed = 0, []


def check(name, ok, detail=None):
    global passed
    if ok:
        passed += 1
    else:
        failed.append(f'{name}: {detail}')


def raises(fn):
    try:
        fn()
    except pl.SlateError as e:
        return str(e)
    return None


def market(sid='10235', wager='rushing_yards', line=12.5, over='1.77', under='1.79', sport='nfl', **kw):
    base = {'status': 'active', 'subject_id': sid, 'season': '2026', 'season_type': 'regular', 'sport': sport,
            'game_id': '202610830', 'wager_type': wager, 'subject_type': 'player', 'outcome_type': 'over_under',
            'line_type': 'normal', 'game_status': 'pre_game', 'updated_at': 1793516949090,
            'pick_stats': {'counts': {'over': 50, 'under': 11, 'total': 61}},
            'options': [
                {'status': 'active', 'outcome': 'over', 'outcome_value': line, 'payout_multiplier': over, 'subject_team': 'CHI'},
                {'status': 'active', 'outcome': 'under', 'outcome_value': line, 'payout_multiplier': under, 'subject_team': 'CHI'},
            ]}
    base.update(kw)
    return base


today = datetime.now(timezone.utc).date()
soon = [{'game_id': '202610830', 'week': 8, 'status': 'pre_game', 'date': (today + timedelta(days=1)).isoformat()}]
far = [{'game_id': '202610901', 'week': 9, 'status': 'pre_game', 'date': (today + timedelta(days=9)).isoformat()}]
done = [{'game_id': '202610701', 'week': 7, 'status': 'complete', 'date': (today - timedelta(days=1)).isoformat()}]


def slate(raw, games):
    """sleeper_slate on a cached slate, with the schedule stubbed."""
    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as fh:
        json.dump(raw, fh)
    real = pl.fetch_json
    pl.fetch_json = lambda url, timeout=60: games
    try:
        return pl.sleeper_slate(2026, fh.name)
    finally:
        pl.fetch_json = real
        os.unlink(fh.name)


# A normal slate parses, with other sports and unpriced wagers ignored.
raw = [market(), market(sid='9221', wager='receptions', line=4.5, over='1.92', under='1.66'),
       market(sid='1', sport='nba', wager='assists'), market(sid='2', wager='longest_rush')]
specs, _ = slate(raw, soon)
check('a normal slate parses its NFL lines', len(specs) == 2 and {s['stat'] for s in specs} == {'rushYds', 'rec'}, specs)
s0 = next(s for s in specs if s['stat'] == 'rushYds')
check('line, both payouts, week and public share read',
      s0['line'] == 12.5 and s0['multOver'] == 1.77 and s0['multUnder'] == 1.79 and s0['week'] == 8
      and s0['publicOver'] == round(50 / 61, 3) and s0['team'] == 'CHI', s0)

# Off weeks and the offseason: no NFL lines and no game soon is fine.
check('no NFL lines with no game in the next days passes', raises(lambda: slate([market(sport='nba', wager='assists')], far)) is None)
check('no NFL lines after the week is done passes', raises(lambda: slate([], done)) is None)
check('no schedule (it failed to load) passes', raises(lambda: slate([], [])) is None)

# Missing: games are coming but the slate has no NFL lines.
msg = raises(lambda: slate([market(sport='nba', wager='assists')], soon))
check('no NFL lines with a game in the next days fails', msg and 'scheduled' in msg, msg)

# Reshaped: not a list, or the fields renamed.
check('a non-list response fails', 'not a list' in (raises(lambda: slate({'lines': raw}, soon)) or ''))
renamed = copy.deepcopy(raw[:2])
for m in renamed:
    for o in m['options']:
        o['payout'] = o.pop('payout_multiplier')
msg = raises(lambda: slate(renamed, soon))
check('renamed option fields fail', msg and 'only 0 of 2' in msg, msg)
msg = raises(lambda: slate([{k: v for k, v in m.items() if k != 'options'} | {'outcomes': m['options']} for m in raw[:2]], soon))
check('renamed market fields fail', msg and 'only 0 of 2' in msg, msg)

# A few odd markets (one side suspended) are not a reshape.
odd = [market(sid=str(i)) for i in range(10)]
odd[0]['options'][1]['status'] = 'suspended'
specs, _ = slate(odd, soon)
check('a suspended side here and there passes', len(specs) == 9, len(specs))

# check=False skips the check (the line tracker prices what it can).
real = pl.fetch_json
pl.fetch_json = lambda url, timeout=60: soon
with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as fh:
    json.dump([], fh)
try:
    specs, _ = pl.sleeper_slate(2026, fh.name, check=False)
    check('check=False returns without raising', specs == [])
finally:
    pl.fetch_json = real
    os.unlink(fh.name)

# check_slate's counts.
c = pl.check_slate(raw, [1, 2], soon, today)
check('check_slate counts what it checked', c == {'markets': 4, 'nfl': 3, 'priceable': 2, 'parsed': 2, 'gamesSoon': 1}, c)

# The published probability (calibrate): shrunk halfway, capped at CAL_CAP, symmetric.
check('calibrate shrinks halfway below the cap', abs(pl.calibrate(0.7) - 0.6) < 1e-9 and pl.calibrate(0.5) == 0.5)
check('calibrate caps at CAL_CAP', pl.calibrate(0.99) == pl.CAL_CAP and pl.calibrate(0.74) == pl.CAL_CAP, pl.calibrate(0.99))
check('calibrate is symmetric (sides sum to 1)', all(abs(pl.calibrate(r) + pl.calibrate(1 - r) - 1) < 1e-9 for r in (0.1, 0.3, 0.55, 0.9)))
check('calibrate never decreases', all(pl.calibrate(a / 100) <= pl.calibrate((a + 1) / 100) for a in range(0, 100)))

print(f'{passed} passed, {len(failed)} failed')
for f in failed:
    print('  ✗', f)
sys.exit(1 if failed else 0)
