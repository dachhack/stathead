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
# A logged lean that re-pricing no longer backs (mark_stale): why, when, and
# StatHead's probability now. No payout: the re-price uses the recorded ones.
STALE_KEEP = ('stale', 'staleAt', 'leanNow', 'pLeanNow')
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
                   'hit', 'push', 'void', 'actual', 'note', 'provisional', 'stale', 'pLeanNow')


def bundles_mod():
    spec = importlib.util.spec_from_file_location('bundles', os.path.join(ROOT, 'scripts', 'build-pick-bundles.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def bundle_board(week, current, graded):
    """This week's bundle sets (scripts/build-pick-bundles.py) with each
    leg's result, and the bundle record over every recorded set. A leg's
    result is its pick's: the official grading, else this week's unofficial
    box-score result. Returns (this week's sets, record)."""
    bm = bundles_mod()
    log = load(bm.BUNDLE_LOG, {}) or {}
    by_key = {bm.leg_key(r): r for r in graded}
    by_key.update({bm.leg_key(r): r for r in current if r.get('provisional') or r.get('void')})
    stale = {bm.leg_key(r): {k: r[k] for k in ('stale', 'pLeanNow') if k in r} for r in current if r.get('stale')}
    sets, record = [], {'bundles': 0, 'won': 0, 'lost': 0, 'open': 0, 'void': 0}
    for st in log.get('sets') or []:
        rows = []
        for b in st.get('bundles') or []:
            legs, status = bm.bundle_results(b, by_key.get)
            if st.get('week') == week:
                legs = [{**l, **stale.get(l.get('key'), {})} for l in legs]
            record['bundles'] += 1
            record[status] += 1
            rows.append({'pAll': b.get('pAll'), 'ev': b.get('ev'), 'status': status,
                         'legs': [{k: l[k] for k in BUNDLE_LEG_KEEP if l.get(k) is not None} for l in legs]})
        if st.get('week') == week:
            sets.append({'builtAt': st.get('builtAt'), 'bundles': rows})
    return sets, (record if record['bundles'] else None)


def mark_stale(season, week, rows, raw, now=None, pricer='auto', prev=None):
    """Mark this week's logged leans that no longer hold. Each open pick (not
    void, not kicked off) is re-priced the way the bundle builder re-prices its
    legs (scripts/build-pick-bundles.py no_longer_holds): the feed no longer
    prices it, the lean flipped, a new guardrail flag, or the edge fell under
    the minimum. A stale row gets `stale` (why), `staleAt`, and StatHead's
    `leanNow` / `pLeanNow`; a row that holds gets nothing.

    Re-pricing needs numpy (the Pricer). Where it is missing (the data
    refresh), or a pick has kicked off, the mark from the previous board
    (`prev`, by leg key) carries forward. `rows` and `raw` are parallel: the
    board row and its log entry. Returns how many were re-priced."""
    now = now or datetime.now(timezone.utc)
    bm = bundles_mod()
    prev_marks = {bm.leg_key(r): {k: r[k] for k in STALE_KEEP if k in r}
                  for r in (prev or {}).get('picks') or [] if r.get('stale')}

    def is_open(r):
        try:
            return not r.get('void') and datetime.fromisoformat(r['kickoff']) > now
        except (KeyError, TypeError, ValueError):
            return False

    todo = [(r, p) for r, p in zip(rows, raw) if is_open(r)]
    if todo and pricer == 'auto':
        try:
            pricer = bm.load_pricer(season, week, now)
        except Exception as e:     # no numpy on this runner, or the feed failed to load
            print(f'pick board: not re-pricing ({type(e).__name__}: {e}); stale marks carried forward')
            pricer = None
    priced = set()
    if todo and pricer not in (None, 'auto'):
        min_edge = constants().get('MIN_EDGE', bm.MIN_EDGE)
        for r, p in todo:
            try:
                now_r = pricer.price(bm.price_spec(p, week))
            except Exception as e:
                print(f"pick board: re-pricing {p.get('player')} {p.get('stat')} failed: {e}")
                continue
            priced.add(id(r))
            why = bm.no_longer_holds(p, now_r, min_edge)
            if why:
                r.update({'stale': why, 'staleAt': now.isoformat(timespec='seconds'),
                          **({'leanNow': now_r['lean'], 'pLeanNow': now_r['pLean']}
                             if now_r.get('lean') and now_r.get('pLean') is not None else {})})
    for r in rows:
        if id(r) not in priced:
            r.update(prev_marks.get(bm.leg_key(r), {}))
    return len(priced)


def build(season, now=None, pricer='auto', prev=None):
    log = load(PICK_LOG, {}) or {}
    picks = log.get('picks', []) if isinstance(log, dict) else log
    acc = load(os.path.join(DATA, 'weekly-projections-accuracy.json'), {}) or {}
    graded_block = acc.get('picks') or {}
    weekly = load(os.path.join(DATA, f'weekly-projections-{season}.json'), {}) or {}
    played = int(weekly.get('playedThrough') or 0)
    week = int(weekly.get('currentWeek') or played + 1)

    games = kickoffs(season, week)
    current, raw = [], []
    for p in picks:
        if p.get('week') != week:
            continue
        row = slim(p)
        row.update(games.get(p.get('team'), {}))
        current.append(row)
        raw.append(p)
    order = sorted(range(len(current)), key=lambda i: (current[i].get('kickoff') or '', -(current[i].get('edge') or 0)))
    current, raw = [current[i] for i in order], [raw[i] for i in order]
    mark_stale(season, week, current, raw, now, pricer, prev)
    this_week = unofficial_results(season, week, current)

    graded = [slim(g, KEEP + GRADE_KEEP) for g in graded_block.get('graded') or []]
    graded.sort(key=lambda r: (-(r.get('week') or 0), r.get('player') or ''))
    bundle_sets, bundle_record = bundle_board(week, current, graded)

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
            'pending': graded_block.get('pending') or 0,
        },
        'note': ('StatHead pick board. Lines are the Sleeper Picks lines StatHead leaned on (an input, shown by owner '
                 'decision 2026-11-01); everything else is StatHead output: our projection, the simulated probability '
                 'of our lean (calibrated), the edge over the payout\'s break-even, and the graded record. Sleeper\'s '
                 'payouts and pick shares are not included. A pick marked stale is one StatHead no longer leans on '
                 'after re-pricing.'),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--season', type=int, default=2026)
    ap.add_argument('--out', default=None)
    args = ap.parse_args()
    out = args.out or os.path.join(DATA, f'pick-board-{args.season}.json')
    board = build(args.season, prev=load(out, None))
    with open(out, 'w') as fh:
        json.dump(board, fh, indent=1)
        fh.write('\n')
    print(f"pick board: week {board['week']}, {len(board['picks'])} picks, {len(board['graded'])} graded → "
          f"{os.path.relpath(out, ROOT)}")


if __name__ == '__main__':
    main()
