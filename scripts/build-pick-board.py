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

This week's picks also carry an unofficial result once their game is final
(the week's nflverse box scores in player_stats_<season>.csv.gz, read the way
the grader reads them); the official grading lands when the whole week is.

Inputs:
  data/pick-log.json                              recorded picks (price-lines.py --record)
  public/data/player_stats_<season>.csv.gz        box scores, for the unofficial results
  public/data/weekly-projections-accuracy.json    their grading (score-weekly-projections.py)
  public/data/weekly-projections-<season>.json    the current week
  public/data/schedule-<season>.json              kickoffs
  scripts/price-lines.py                          CAL_SHRINK, CAL_CAP, MIN_EDGE (read, not imported)

Usage:  python3 scripts/build-pick-board.py [--season 2026] [--out public/data/pick-board-2026.json]
"""
from __future__ import annotations

import argparse
import ast
import csv
import gzip
import importlib.util
import json
import os
import re
from datetime import datetime, timezone
from types import SimpleNamespace

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
    for name in ('CAL_SHRINK', 'CAL_CAP', 'MIN_EDGE'):
        m = re.search(rf'^{name}\s*=\s*([0-9.]+)', src, re.M)
        if m:
            out[name] = float(m.group(1))
    return out


def slim(p, keep=KEEP):
    return {k: p[k] for k in keep if k in p and p[k] is not None}


def scorer():
    """The grader's stat mapping (STAT_COLS, PICK_STATS in
    scripts/score-weekly-projections.py), so unofficial results match the
    official grading. Read from its source as literals rather than imported:
    the grader needs numpy, and the data refresh that rebuilds this board
    runs on the bare runner Python."""
    tree = ast.parse(open(os.path.join(ROOT, 'scripts', 'score-weekly-projections.py')).read())
    found = {}
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name) \
                and node.targets[0].id in ('STAT_COLS', 'PICK_STATS'):
            found[node.targets[0].id] = ast.literal_eval(node.value)
    pick_stats = found['PICK_STATS']

    def pick_actual(sa, stat):
        comps = pick_stats.get(stat)
        if not comps or not sa:
            return None
        return float(sum(sa.get(c, 0.0) for c in comps))
    return SimpleNamespace(STAT_COLS=found['STAT_COLS'], PICK_STATS=pick_stats, pick_actual=pick_actual)


def box_scores(season, week, sc):
    """(teams whose week-`week` game has a box score, {gsis: stat line})."""
    path = os.path.join(DATA, f'player_stats_{season}.csv.gz')
    teams, lines = set(), {}
    if not os.path.exists(path):
        return teams, lines
    with gzip.open(path, 'rt') as fh:
        for r in csv.DictReader(fh):
            if r.get('season_type', 'REG') != 'REG' or r.get('week') != str(week):
                continue
            teams.add(r.get('team') or r.get('recent_team'))
            try:
                lines[r['player_id']] = {k: float(r.get(col) or 0) for k, (_, col, _) in sc.STAT_COLS.items()}
            except ValueError:
                continue
    return teams, lines


def unofficial_results(season, week, rows):
    """Mark each of this week's picks whose game is final with its actual
    and hit / push (`provisional`); a player with no box score in a final game
    did not play. Returns the week's running record."""
    sc = scorer()
    teams, lines = box_scores(season, week, sc)
    done = []
    for r in rows:
        if r.get('void') or r.get('team') not in teams:
            continue
        r['provisional'] = True
        actual = sc.pick_actual(lines.get(r.get('gsis')), r['stat'])
        if actual is None:
            r.update({'actual': None, 'hit': None, 'note': 'did not play'})
            continue
        push = actual == r['line']
        r.update({'actual': round(actual, 1), 'push': push,
                  'hit': None if push else (actual > r['line']) == (r['lean'] == 'over')})
        if r['hit'] is not None:
            done.append(r)
    if not done:
        return None
    hits = sum(1 for r in done if r['hit'])
    return {'n': len(done), 'hits': hits, 'hitRate': round(hits / len(done), 3),
            'expectedHitRate': round(sum(r['pLean'] for r in done) / len(done), 3),
            'calls': sum(1 for r in done if r.get('tag') == 'call'),
            'callHits': sum(1 for r in done if r.get('tag') == 'call' and r['hit'])}


def kickoffs(season, week):
    sched = load(os.path.join(DATA, f'schedule-{season}.json'), {})
    games = sched.get('games', sched) if isinstance(sched, dict) else sched
    out = {}
    for g in games or []:
        if g.get('week') == week:
            for side, opp in (('home', 'away'), ('away', 'home')):
                out[g[side]] = {'kickoff': g['date'], 'opp': g[opp], 'home': side == 'home'}
    return out


# Bundle leg fields the page may show (no payout: the leg's mult stays in
# data/pick-bundles.json).
BUNDLE_LEG_KEEP = ('player', 'gsis', 'pos', 'team', 'stat', 'line', 'lean', 'pLean', 'edge', 'game', 'tag',
                   'hit', 'push', 'void', 'actual', 'note', 'provisional')


def bundles_mod():
    spec = importlib.util.spec_from_file_location('bundles', os.path.join(ROOT, 'scripts', 'build-pick-bundles.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def superseded_bundles(sets, kickoff_of):
    """Indices (set, bundle) of bundles a later set of the same week replaced
    before any of their games kicked off. Each pricing run records a new set
    for the games still to play, and the early sets reuse the same legs
    (week 9 of 2026: three sets, 15 bundles, four losing legs in 9 of them),
    so counting every set's bundles weighs one leg's result several times.
    A bundle counts only if it was the newest set's when its first game
    started. kickoff_of(week, team) -> ISO kickoff or None."""
    out = set()
    for i, st in enumerate(sets):
        later = [s.get('builtAt') or '' for s in sets[i + 1:] if s.get('week') == st.get('week')]
        if not later:
            continue
        for j, b in enumerate(st.get('bundles') or []):
            kicks = [kickoff_of(st.get('week'), l.get('team')) for l in b.get('legs') or []]
            kicks = [k for k in kicks if k]
            first = min(kicks, key=_utc) if kicks else None
            if first and any(_utc(t) < _utc(first) for t in later):
                out.add((i, j))
    return out


def _utc(iso):
    t = datetime.fromisoformat(iso.replace('Z', '+00:00'))
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def bundle_board(week, current, graded, season=2026, all_graded=None):
    """This week's bundle sets (scripts/build-pick-bundles.py) with each
    leg's result, and the bundle record over the bundles that were in force
    (superseded_bundles()). A leg's result is its pick's: the official
    grading, else this week's unofficial box-score result. all_graded: every
    graded row, superseded recordings included (a bundle leg may be one).
    Returns (this week's sets, record)."""
    bm = bundles_mod()
    log = load(bm.BUNDLE_LOG, {}) or {}
    # Keyed by week too: a leg key (player, stat, line, side) recurs across
    # weeks, and without the week a week-10 leg took its week-9 twin's result
    # (Dak Prescott pass TDs under 1.5, 2026: two week-10 bundles shown lost
    # before kickoff).
    by_key = {(r.get('week'), bm.leg_key(r)): r for r in (all_graded if all_graded is not None else graded)}
    by_key.update({(r.get('week'), bm.leg_key(r)): r for r in current if r.get('provisional') or r.get('void')})
    games = {}

    def kickoff_of(w, team):
        if w not in games:
            games[w] = bm.games_by_team(season, w)
        return (games[w].get(team) or (None, None))[1]

    log_sets = log.get('sets') or []
    gone = superseded_bundles(log_sets, kickoff_of)
    sets, record = [], {'bundles': 0, 'won': 0, 'lost': 0, 'open': 0, 'void': 0, 'superseded': 0}
    for i, st in enumerate(log_sets):
        rows = []
        for j, b in enumerate(st.get('bundles') or []):
            legs, status = bm.bundle_results(b, lambda k, w=st.get('week'): by_key.get((w, k)))
            if (i, j) in gone:
                record['superseded'] += 1
            else:
                record['bundles'] += 1
                record[status] += 1
            rows.append({'pAll': b.get('pAll'), 'ev': b.get('ev'), 'status': status,
                         **({'superseded': True} if (i, j) in gone else {}),
                         'legs': [{k: l[k] for k in BUNDLE_LEG_KEEP if l.get(k) is not None} for l in legs]})
        if st.get('week') == week:
            sets.append({'builtAt': st.get('builtAt'), 'bundles': rows})
    return sets, (record if record['bundles'] else None)


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
    this_week = unofficial_results(season, week, current)

    all_graded = [slim(g, KEEP + GRADE_KEEP) for g in graded_block.get('graded') or []]
    # The record counts one recording per player, stat and week (the scorer
    # marks the rest superseded); the board lists the ones it counts.
    graded = [slim(g, KEEP + GRADE_KEEP) for g in graded_block.get('graded') or [] if not g.get('superseded')]
    graded.sort(key=lambda r: (-(r.get('week') or 0), r.get('player') or ''))
    bundle_sets, bundle_record = bundle_board(week, current, graded, season, all_graded)

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
            'calCap': c.get('CAL_CAP'),
            'minEdge': c.get('MIN_EDGE'),
            'draws': 20000,
        },
        'picks': current,
        'graded': graded,
        'thisWeek': this_week,
        'bundles': bundle_sets,
        'bundleRecord': bundle_record,
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
            'superseded': graded_block.get('superseded') or 0,
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
