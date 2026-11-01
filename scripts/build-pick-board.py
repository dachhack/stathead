#!/usr/bin/env python3
"""Build the site's pick board (public/data/pick-board-<season>.json) from the
pick log and its grading.

The Research > Sleeper Picks page reads this file: the week's recorded leans,
how StatHead priced each one, and the graded record that validates the model.

What it may show is narrower than what the log holds. Sleeper Picks' lines
are third-party input (docs/third-party-data-policy.md); by owner decision
(2026-11-01) the page shows the lines StatHead leaned on, with our lean,
probability, edge and projection. Sleeper's payouts, public pick shares and
pick counts are never written here, nor anything they can be read back from
per pick (break-even, EV, return): KEEP is an allowlist, so a field added to
the log stays out until it is added here on purpose.

Inputs:
  data/pick-log.json                              recorded picks (price-lines.py --record)
  public/data/weekly-projections-accuracy.json    their grading (score-weekly-projections.py)
  public/data/weekly-projections-<season>.json    the current week
  public/data/schedule-<season>.json              kickoffs
  scripts/price-lines.py                          CAL_SHRINK, MIN_EDGE (read, not imported)

Usage:  python3 scripts/build-pick-board.py [--season 2026] [--out public/data/pick-board-2026.json]
"""
from __future__ import annotations

import argparse
import json
import os
import re
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'public', 'data')
PICK_LOG = os.path.join(ROOT, 'data', 'pick-log.json')

# Per-pick fields the page may show. Not here on purpose: mult, multNow,
# multOver, multUnder, breakeven, ev, ret, publicOver, publicOverNow, picks,
# lineHistory, sleeper, game_id, source.
KEEP = ('week', 'player', 'gsis', 'pos', 'team', 'stat', 'line', 'lean', 'pLean', 'pRaw', 'edge',
        'proj', 'median', 'matchup', 'flags', 'tag', 'recordedAt', 'lineNow', 'lineMove', 'void')
GRADE_KEEP = ('actual', 'hit', 'push', 'note')
# Summary fields: aggregate results over many picks, StatHead's own record.
SUMMARY_KEEP = ('n', 'hits', 'hitRate', 'expectedHitRate', 'rawExpectedHitRate', 'return', 'roi')

STAT_LABELS = {
    'rec': 'Receptions', 'recYds': 'Receiving yards', 'rushYds': 'Rushing yards', 'rushAtt': 'Rush attempts',
    'passYds': 'Passing yards', 'passTD': 'Passing TDs', 'tgt': 'Targets', 'anyTD': 'Anytime TD',
    'rushRecYds': 'Rush + rec yards', 'passRushYds': 'Pass + rush yards', 'passAtt': 'Pass attempts',
    'passCmp': 'Completions', 'int': 'Interceptions',
}


def load(path, default=None):
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


def constants():
    """CAL_SHRINK and MIN_EDGE as price-lines.py has them (parsed, so this
    script needs neither numpy nor the scorer)."""
    out = {}
    try:
        src = open(os.path.join(ROOT, 'scripts', 'price-lines.py')).read()
    except OSError:
        return out
    for name in ('CAL_SHRINK', 'MIN_EDGE'):
        m = re.search(rf'^{name}\s*=\s*([0-9.]+)', src, re.M)
        if m:
            out[name] = float(m.group(1))
    return out


def slim(p, keep=KEEP):
    return {k: p[k] for k in keep if k in p and p[k] is not None}


def kickoffs(season, week):
    sched = load(os.path.join(DATA, f'schedule-{season}.json'), {})
    games = sched.get('games', sched) if isinstance(sched, dict) else sched
    out = {}
    for g in games or []:
        if g.get('week') == week:
            for side, opp in (('home', 'away'), ('away', 'home')):
                out[g[side]] = {'kickoff': g['date'], 'opp': g[opp], 'home': side == 'home'}
    return out


def build(season):
    log = load(PICK_LOG, {}) or {}
    picks = log.get('picks', []) if isinstance(log, dict) else log
    acc = load(os.path.join(DATA, 'weekly-projections-accuracy.json'), {}) or {}
    graded_block = acc.get('picks') or {}
    weekly = load(os.path.join(DATA, f'weekly-projections-{season}.json'), {}) or {}
    played = int(weekly.get('playedThrough') or 0)
    week = int(weekly.get('currentWeek') or played + 1)

    games = kickoffs(season, week)
    current = []
    for p in picks:
        if p.get('week') != week:
            continue
        row = slim(p)
        row.update(games.get(p.get('team'), {}))
        current.append(row)
    current.sort(key=lambda r: (r.get('kickoff') or '', -(r.get('edge') or 0)))

    graded = [slim(g, KEEP + GRADE_KEEP) for g in graded_block.get('graded') or []]
    graded.sort(key=lambda r: (-(r.get('week') or 0), r.get('player') or ''))

    def summ(x):
        return {k: x[k] for k in SUMMARY_KEEP if k in x} if isinstance(x, dict) else None

    def summ_map(m):
        return {k: summ(v) for k, v in (m or {}).items() if v}

    c = constants()
    return {
        'season': season,
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'week': week,
        'playedThrough': played,
        'statLabels': STAT_LABELS,
        'method': {
            'calShrink': c.get('CAL_SHRINK'),
            'minEdge': c.get('MIN_EDGE'),
            'draws': 20000,
        },
        'picks': current,
        'graded': graded,
        'validation': {
            'overall': summ(graded_block.get('overall')),
            'byConfidence': summ_map(graded_block.get('byConfidence')),
            'byWeek': summ_map(graded_block.get('byWeek')),
            'byTag': summ_map(graded_block.get('byTag')),
            'byStat': summ_map(graded_block.get('byStat')),
            'byMove': summ_map(graded_block.get('byMove')),
            'flagged': summ(graded_block.get('flagged')),
            'unflagged': summ(graded_block.get('unflagged')),
            'voided': graded_block.get('voided') or 0,
            'pending': graded_block.get('pending') or 0,
        },
        'note': ('StatHead pick board. Lines are the Sleeper Picks lines StatHead leaned on (an input, shown by owner '
                 'decision 2026-11-01); everything else is StatHead output: our projection, the simulated probability '
                 'of our lean (calibrated), the edge over the payout\'s break-even, and the graded record. Sleeper\'s '
                 'payouts and pick shares are not included.'),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--season', type=int, default=2026)
    ap.add_argument('--out', default=None)
    args = ap.parse_args()
    out = args.out or os.path.join(DATA, f'pick-board-{args.season}.json')
    board = build(args.season)
    with open(out, 'w') as fh:
        json.dump(board, fh, indent=1)
        fh.write('\n')
    print(f"pick board: week {board['week']}, {len(board['picks'])} picks, {len(board['graded'])} graded → "
          f"{os.path.relpath(out, ROOT)}")


if __name__ == '__main__':
    main()
