#!/usr/bin/env python3
"""Price pick lines against the week's StatHead projections, and record them.

A line is a player, a stat, a number and the payout per leg (the app's
multiplier per side; default 1.78). Each is priced from the player's week
stat line (public/data/weekly-projections-2026.json: statsPG split for the
week's matchup) and the stat-line simulation of
scripts/score-weekly-projections.py (gamma volume, binomial receptions,
summed gamma yards, Poisson TDs): P(over) = the share of draws above the
line. The lean is the side with the higher probability. The published
P(lean) is calibrated: on a proxy back test the raw simulation probability
ranked outcomes correctly but overstated them by about half, so
P(lean) = 0.5 + CAL_SHRINK x (raw - 0.5), with the raw share kept as pRaw.
The edge is P(lean) against the side's break-even (1 / its multiplier), and
ev the return per unit at that payout.

Two sources of lines:
  arguments   'Player stat 54.5 [@1.78]' (or --file, one per row): lines
              typed from an app
  --sleeper   Sleeper Picks' own slate, read from its public lines endpoint
              (api.sleeper.app/lines/available), NFL player over/unders
              only, joined to the feed on Sleeper id. The slate is a
              third-party input: it is cached under .cache/sleeper-lines/
              (not committed) and only the lines we take are recorded.
              --slate FILE prices a cached slate instead of fetching.

Guardrails (flags on the row; a flagged line is priced but not trusted):
  status      the player, or a position-mate on his team, is Questionable /
              Doubtful / Out for the week (the line is conditional on
              playing, and the book knows more about the game-time call)
  role        the share-based role update moved his line 15%+ (the pool
              and his recent usage disagree; the book sees the same usage)
  form        his last-3-game average of the stat is 40%+ away from the
              projection, with 3+ games played (the season average lags)
  games       fewer than 3 games played this season
  thin        a projected volume under 2 (targets) / 4 (carries) / 10
              (attempts): the dispersion fits start there
  started     the week's game for his team has already kicked off

--record appends picks to data/pick-log.json (committed, not deployed) with
the timestamp, so the scorer can grade them once the week is final (the
Pick lines card in the daily report: hit rate, calibration by confidence,
return). Typed lines are all recorded; from --sleeper only unflagged leans
with at least --min-edge (default 0.02, on the calibrated P) are, unless
--record-all. --pick "Player stat" records a named slate line regardless,
and --tag labels what is recorded (--tag call for the picks we actually
made, so the grading can tell our calls from the scheduler's leans).

Usage:
  python3 scripts/price-lines.py "Germie Bernard recYds 54.5" "Jaylin Noel rec yds 27.5 @1.78" [--record]
  python3 scripts/price-lines.py --file lines.txt [--mult 1.78] [--week 8]
  python3 scripts/price-lines.py --sleeper [--week 8] [--min-edge 0.02] [--record] [--json]
Stats: recYds (receiving yards), rushYds, passYds, rec (receptions), tgt,
rushAtt, passTD, rushRecYds (rush + rec yards), passRushYds (pass + rush
yards), anyTD (rush + rec TDs). Aliases like "rec yds" / "receiving yards" /
"rush+rec yds" are accepted.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import sys
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'public', 'data')
CACHE = os.path.join(ROOT, '.cache', 'sleeper-lines')
_spec = importlib.util.spec_from_file_location('scorer', os.path.join(ROOT, 'scripts', 'score-weekly-projections.py'))
sc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sc)

DEFAULT_MULT = 1.78
DRAWS = 20000
MIN_EDGE = 0.02   # on the calibrated probability; the proxy back test's ROI turned positive about here
# Calibration. On a proxy back test (weeks 1-6 of 2026, 2,429 lines set at
# an external projection's own number) the raw simulation probability ranked
# outcomes correctly but overstated them by about half: it hit 50.6 / 52.8 /
# 56.9 / 57.6 / 62.4% in the 50-54 / 54-58 / 58-62 / 62-70 / 70%+ buckets
# against its own 51.9 / 56.0 / 60.0 / 65.5 / 80.8%. The published
# probability is therefore 0.5 + CAL_SHRINK x (raw - 0.5); edge and EV use
# it, and the raw number rides along as pRaw. The weekly grading's
# calibration-by-confidence table is what re-tunes this.
CAL_SHRINK = 0.5
STAT_ALIASES = {
    'recyds': 'recYds', 'receivingyards': 'recYds', 'recyards': 'recYds', 'receivingyds': 'recYds',
    'rushyds': 'rushYds', 'rushingyards': 'rushYds', 'rushyards': 'rushYds', 'rushingyds': 'rushYds',
    'passyds': 'passYds', 'passingyards': 'passYds', 'passyards': 'passYds', 'passingyds': 'passYds',
    'rec': 'rec', 'receptions': 'rec', 'catches': 'rec', 'tgt': 'tgt', 'targets': 'tgt',
    'rushatt': 'rushAtt', 'carries': 'rushAtt', 'rushattempts': 'rushAtt', 'rushingattempts': 'rushAtt',
    'passtd': 'passTD', 'passingtds': 'passTD', 'passtds': 'passTD', 'passingtouchdowns': 'passTD',
    'rushrecyds': 'rushRecYds', 'rush+recyds': 'rushRecYds', 'rush+recyards': 'rushRecYds', 'rushandrecyds': 'rushRecYds',
    'scrimmageyards': 'rushRecYds', 'rushrecyards': 'rushRecYds', 'rushingandreceivingyards': 'rushRecYds',
    'passrushyds': 'passRushYds', 'pass+rushyds': 'passRushYds', 'pass+rushyards': 'passRushYds', 'passandrushyds': 'passRushYds',
    'passingandrushingyards': 'passRushYds',
    'anytd': 'anyTD', 'anytimetd': 'anyTD', 'rushrectd': 'anyTD', 'rush+rectd': 'anyTD', 'rushrectds': 'anyTD', 'anytimetouchdowns': 'anyTD',
}
# Sleeper Picks wager types -> our stats (the rest, fantasy points, longest
# plays, kicking and defense, are not priced).
SLEEPER_WAGERS = {
    'receiving_yards': 'recYds', 'receptions': 'rec', 'rushing_yards': 'rushYds', 'passing_yards': 'passYds',
    'rushing_attempts': 'rushAtt', 'passing_touchdowns': 'passTD', 'rushing_and_receiving_yards': 'rushRecYds',
    'passing_and_rushing_yards': 'passRushYds', 'anytime_touchdowns': 'anyTD',
}
SLEEPER_LINES_URL = 'https://api.sleeper.app/lines/available?dynamic=true&include_preseason=true&eg=15.0'
SLEEPER_SCHEDULE_URL = 'https://api.sleeper.app/schedule/nfl/regular/{season}'
STATUS_FLAG = ('Questionable', 'Doubtful', 'Out', 'IR', 'PUP', 'Sus')
MATE_FLAG = ('Questionable', 'Doubtful', 'Out')
ROLE_FLAG = 0.15
FORM_FLAG = 0.40
FORM_GAMES = 3
THIN = {'tgt': 2.0, 'rushAtt': 4.0, 'passAtt': 10.0}
LINE_RE = re.compile(r'^\s*(?P<body>.+?)\s+(?P<line>\d+(?:\.\d+)?)\s*(?:@\s*(?P<mult>\d+(?:\.\d+)?)x?)?\s*$')


def norm_name(s):
    return sc.norm_name(s)


def stat_key(raw):
    key = re.sub(r'[\s_\-]', '', raw).lower()
    if key in STAT_ALIASES:
        return STAT_ALIASES[key]
    for k in sc.PICK_STATS:
        if k.lower() == key:
            return k
    return None


def parse_stat(raw):
    k = stat_key(raw)
    if not k:
        raise SystemExit(f"unknown stat '{raw}' (known: {', '.join(sc.PICK_STATS)})")
    return k


def split_name_stat(body):
    """'Germie Bernard rec yds' -> ('Germie Bernard', 'recYds'): the stat is
    the longest trailing run of words (up to 4) that names a stat."""
    words = body.split()
    for k in range(min(4, len(words) - 1), 0, -1):
        st = stat_key(' '.join(words[-k:]))
        if st:
            return ' '.join(words[:-k]), st
    raise SystemExit(f"no stat found in '{body}' (known: {', '.join(sc.PICK_STATS)})")


def parse_line(spec, default_mult):
    """'Player Name stat 54.5 [@1.78]' or 'Player Name|stat|54.5[|1.78]' ->
    {'name', 'stat', 'line', 'multOver', 'multUnder', 'source'}."""
    if '|' in spec:
        parts = [x.strip() for x in spec.split('|')]
        if len(parts) < 3:
            raise SystemExit(f"bad line '{spec}'")
        mult = float(parts[3]) if len(parts) > 3 and parts[3] else default_mult
        return {'name': parts[0], 'stat': parse_stat(parts[1]), 'line': float(parts[2]), 'multOver': mult, 'multUnder': mult, 'source': 'typed'}
    m = LINE_RE.match(spec)
    if not m:
        raise SystemExit(f"bad line '{spec}' (expected 'Player stat 54.5 [@1.78]')")
    name, stat = split_name_stat(m['body'])
    mult = float(m['mult']) if m['mult'] else default_mult
    return {'name': name, 'stat': stat, 'line': float(m['line']), 'multOver': mult, 'multUnder': mult, 'source': 'typed'}


def fetch_json(url, timeout=60):
    req = urllib.request.Request(url, headers={'User-Agent': 'stathead-price-lines/1.0'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def sleeper_slate(season, slate_path=None):
    """NFL player over/under lines from Sleeper Picks, as line specs keyed by
    Sleeper id, with the slate cached under .cache/sleeper-lines/. Returns
    (specs, cache_path). A spec: {'sleeper', 'name': None, 'stat', 'line',
    'multOver', 'multUnder', 'game_id', 'week', 'publicOver', 'picks',
    'updatedAt', 'source': 'sleeper'}."""
    if slate_path:
        raw = json.load(open(slate_path))
        path = slate_path
    else:
        raw = fetch_json(SLEEPER_LINES_URL)
        os.makedirs(CACHE, exist_ok=True)
        path = os.path.join(CACHE, datetime.now(timezone.utc).strftime('%Y-%m-%dT%H%M') + '.json')
        json.dump(raw, open(path, 'w'))
    weeks = {}
    try:
        for g in fetch_json(SLEEPER_SCHEDULE_URL.format(season=season)):
            weeks[str(g.get('game_id'))] = g.get('week')
    except Exception as e:  # noqa: BLE001 - the week can also come from the feed's currentWeek
        print(f'warning: Sleeper schedule not read ({e}); lines take the current week', file=sys.stderr)
    specs = []
    for l in raw:
        if l.get('sport') != 'nfl' or l.get('subject_type') != 'player' or l.get('outcome_type') != 'over_under':
            continue
        if l.get('status') != 'active' or l.get('line_type', 'normal') != 'normal' or l.get('game_status') not in (None, 'pre_game'):
            continue
        stat = SLEEPER_WAGERS.get(l.get('wager_type'))
        if not stat:
            continue
        opts = {o.get('outcome'): o for o in l.get('options', []) if o.get('status', 'active') == 'active'}
        over, under = opts.get('over'), opts.get('under')
        if not over or not under:
            continue
        try:
            line = float(over.get('outcome_value'))
            mo, mu = float(over.get('payout_multiplier')), float(under.get('payout_multiplier'))
        except (TypeError, ValueError):
            continue
        counts = (l.get('pick_stats') or {}).get('counts') or {}
        total = counts.get('total') or 0
        specs.append({'sleeper': str(l.get('subject_id')), 'name': None, 'stat': stat, 'line': line, 'multOver': mo, 'multUnder': mu,
                      'game_id': str(l.get('game_id')), 'week': weeks.get(str(l.get('game_id'))),
                      'publicOver': round(counts.get('over', 0) / total, 3) if total else None, 'picks': total,
                      'updatedAt': l.get('updated_at'), 'source': 'sleeper', 'team': over.get('subject_team')})
    return specs, path


def find_player(players, name):
    n = norm_name(name)
    exact = [p for p in players if norm_name(p['name']) == n]
    if exact:
        return exact[0]
    loose = [p for p in players if n in norm_name(p['name']) or norm_name(p['name']) in n]
    return loose[0] if len(loose) == 1 else None


def week_line(p, week):
    m = (p['wk'][week - 1] or 0) / p['ppg'] if p.get('ppg') and p['wk'][week - 1] else None
    if m is None or not p.get('statsPG'):
        return None, None
    return sc.split_line(p['statsPG'], p.get('statSplit'), m), m


def status_for(p, week):
    for key in ('inj', 'slp'):
        d = p.get(key)
        if isinstance(d, dict) and d.get('week') == week and d.get('status') in STATUS_FLAG:
            return d['status']
    if p.get('active') is False:
        return 'inactive'
    return None


def kicked_off(schedule, team, week, now):
    for g in schedule.get('games', []):
        if g.get('week') == week and team in (g.get('home'), g.get('away')) and g.get('date'):
            try:
                return datetime.fromisoformat(g['date']).astimezone(timezone.utc) <= now
            except ValueError:
                return False
    return False


class Pricer:
    def __init__(self, season, week, now):
        self.season, self.week, self.now = season, week, now
        self.doc = json.load(open(os.path.join(DATA, f'weekly-projections-{season}.json')))
        self.bands = json.load(open(os.path.join(DATA, 'weekly-projections-bands.json')))
        self.schedule = json.load(open(os.path.join(DATA, f'schedule-{season}.json')))
        self.act_stats = sc.load_actual_stats(season)
        self.games_played = defaultdict(int)
        for (g, _w) in self.act_stats:
            self.games_played[g] += 1
        self.players = [p for p in self.doc['players'] if p.get('pos') in sc.POS and p.get('wk')]
        self.by_sleeper = {str(p['sleeper']): p for p in self.players if p.get('sleeper')}
        if not week:
            self.week = int(self.doc.get('currentWeek') or self.doc.get('playedThrough', 0) + 1)

    def price(self, spec):
        week = spec.get('week') or self.week
        stat, line = spec['stat'], spec['line']
        row = {'player': spec.get('name') or spec.get('sleeper'), 'stat': stat, 'line': line, 'week': week, 'source': spec['source'],
               'multOver': spec['multOver'], 'multUnder': spec['multUnder']}
        for k in ('publicOver', 'picks', 'game_id'):
            if spec.get(k) is not None:
                row[k] = spec[k]
        p = self.by_sleeper.get(spec['sleeper']) if spec.get('sleeper') else find_player(self.players, spec['name'])
        if not p:
            return {**row, 'error': 'not in the weekly feed' + ('' if spec.get('sleeper') else ' (check the name)')}
        row.update({'player': p['name'], 'gsis': p.get('gsis'), 'sleeper': p.get('sleeper'), 'pos': p['pos'], 'team': p['team']})
        if week > len(p['wk']):
            return {**row, 'error': f'week {week} is past the schedule'}
        wl, m = week_line(p, week)
        params = (self.bands.get('simulation') or {}).get('params', {}).get(p['pos'])
        if not wl or not params:
            return {**row, 'error': 'no week stat line (bye, inactive or no simulation parameters for the position)'}
        comps = sc.PICK_STATS[stat]
        proj = float(sum(wl.get(c, 0.0) for c in comps))
        rng = np.random.default_rng(int.from_bytes(f"{p['name']}|{week}".encode(), 'little') % (2 ** 32))
        d = sc.simulate_stats(wl, p['pos'], params, rng, DRAWS)
        missing = [c for c in comps if c not in d]
        if missing:
            return {**row, 'proj': round(proj, 1), 'error': f"the simulation does not draw {', '.join(missing)} for a {p['pos']}"}
        x = sum(d[c] for c in comps)
        p_over = float(np.mean(x > line))
        p_push = float(np.mean(x == line))
        p_under = 1 - p_over - p_push
        lean = 'over' if p_over > p_under else 'under'
        p_raw = max(p_over, p_under)
        p_lean = 0.5 + CAL_SHRINK * (p_raw - 0.5)
        mult = spec['multOver'] if lean == 'over' else spec['multUnder']
        breakeven = 1 / mult
        flags = []
        st = status_for(p, week)
        if st:
            flags.append(f'status:{st}')
        # A position-mate's game-week call (IR / PUP / suspension are season-long
        # absences the pool already prices; a Questionable / Doubtful / Out mate
        # is this week's news).
        mates = [q for q in self.players if q['team'] == p['team'] and q['pos'] == p['pos'] and q is not p and (q.get('ppg') or 0) >= 4]
        mate_st = [f"{q['name']} {status_for(q, week)}" for q in mates if status_for(q, week) in MATE_FLAG]
        if mate_st:
            flags.append('mate:' + '; '.join(mate_st))
        f = (p.get('roleAdj') or {}).get('factor')
        if f and abs(f - 1) >= ROLE_FLAG:
            flags.append(f'role:x{f:.2f}')
        gp = self.games_played.get(p.get('gsis'), 0)
        if gp < FORM_GAMES:
            flags.append(f'games:{gp}')
        else:
            recent = [sc.pick_actual(self.act_stats.get((p['gsis'], w)), stat) for w in range(week - 1, 0, -1)
                      if (p['gsis'], w) in self.act_stats][:FORM_GAMES]
            if len(recent) >= FORM_GAMES and proj > 0:
                avg = float(np.mean(recent))
                if abs(avg - proj) / proj >= FORM_FLAG:
                    flags.append(f'form:last{len(recent)} {avg:.1f} vs proj {proj:.1f}')
        vols = {('tgt' if c in ('rec', 'recYds', 'recTD', 'tgt') else 'rushAtt' if c in ('rushYds', 'rushTD', 'rushAtt') else 'passAtt')
                for c in comps}
        for v, lo in THIN.items():
            if v in vols and wl.get(v, 0) < lo:
                flags.append(f'thin:{v} {wl.get(v, 0):.1f}')
        if kicked_off(self.schedule, p['team'], week, self.now):
            flags.append('started')
        return {**row, 'proj': round(proj, 1), 'median': round(float(np.median(x)), 1), 'pOver': round(p_over, 3),
                'pUnder': round(p_under, 3), 'lean': lean, 'pRaw': round(p_raw, 3), 'pLean': round(p_lean, 3), 'calShrink': CAL_SHRINK,
                'mult': mult, 'breakeven': round(breakeven, 3),
                'edge': round(p_lean - breakeven, 3), 'ev': round(p_lean * mult - 1, 3), 'flags': flags,
                'matchup': round(m, 2), 'recordedAt': self.now.isoformat(timespec='seconds')}


def render(rows, week, now, default_mult):
    print(f"Week {week} pick lines priced {now.strftime('%Y-%m-%d %H:%M')} UTC (break-even at {default_mult}x = {1 / default_mult:.1%})\n")
    print('P(lean) is calibrated (0.5 + %.2f x (raw - 0.5)); raw is the simulation\'s own share of draws.\n' % CAL_SHRINK)
    print('| player | pos | stat | line | proj | median | lean | P(lean) | raw | payout | edge | EV/unit | public over | flags |')
    print('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
    for r in rows:
        if r.get('error'):
            print(f"| {r['player']} | {r.get('pos', '')} | {r['stat']} | {r['line']} | — | — | — | — | — | — | — | — | — | {r['error']} |")
            continue
        pub = f"{r['publicOver']:.0%} ({r.get('picks', 0)})" if r.get('publicOver') is not None else '—'
        print(f"| {r['player']} | {r['pos']} | {r['stat']} | {r['line']} | {r['proj']} | {r['median']} | "
              f"{r['lean']} | {r['pLean']:.0%} | {r['pRaw']:.0%} | {r['mult']:.2f}x | {r['edge']:+.1%} | {r['ev']:+.2f} | {pub} | {'; '.join(r['flags']) or '—'} |")


def record(rows):
    log = {'note': 'Pick lines priced by scripts/price-lines.py --record, graded by the weekly scorer. Typed lines and their payouts '
                   'are the user\'s inputs; Sleeper-sourced lines are the ones StatHead leaned on (an input, not a feed: the slate '
                   'itself is not stored here). Everything else is StatHead output.', 'picks': []}
    if os.path.exists(sc.PICK_LOG):
        try:
            log = json.load(open(sc.PICK_LOG))
        except ValueError:
            pass
    existing = {(p.get('gsis'), p.get('week'), p.get('stat'), p.get('line')) for p in log['picks']}
    added = 0
    for r in rows:
        key = (r.get('gsis'), r['week'], r['stat'], r['line'])
        if key in existing:
            continue
        log['picks'].append(r)
        existing.add(key)
        added += 1
    os.makedirs(os.path.dirname(sc.PICK_LOG), exist_ok=True)
    json.dump(log, open(sc.PICK_LOG, 'w'), indent=1)
    print(f"\nrecorded {added} new pick(s) in {os.path.relpath(sc.PICK_LOG, ROOT)} ({len(log['picks'])} total)", file=sys.stderr)
    return added


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('lines', nargs='*', help="'Player stat 54.5 [@1.78]'")
    ap.add_argument('--file', help='one line per row, same syntax')
    ap.add_argument('--sleeper', action='store_true', help="price Sleeper Picks' current NFL slate")
    ap.add_argument('--slate', help='a cached Sleeper slate (JSON) to price instead of fetching')
    ap.add_argument('--mult', type=float, default=DEFAULT_MULT, help='payout per leg when a typed line gives none')
    ap.add_argument('--week', type=int, help='NFL week (default: the feed\'s currentWeek; Sleeper lines carry their own)')
    ap.add_argument('--season', type=int, default=2026)
    ap.add_argument('--min-edge', type=float, default=MIN_EDGE, help='Sleeper mode: record only leans with at least this edge')
    ap.add_argument('--include-flagged', action='store_true', help='Sleeper mode: record flagged leans too')
    ap.add_argument('--record', action='store_true', help='append the picks to data/pick-log.json')
    ap.add_argument('--tag', default=None, help="label the recorded picks (e.g. 'call' for picks we actually made; the grading splits by tag)")
    ap.add_argument('--pick', action='append', default=[], metavar='"Player stat"',
                    help='Sleeper mode: record this slate line regardless of edge or flags (repeatable); with --tag marks it a call')
    ap.add_argument('--record-all', action='store_true', help='Sleeper mode: record every priced line, not just the leans')
    ap.add_argument('--json', action='store_true', help='print JSON rows instead of a table')
    args = ap.parse_args()
    now = datetime.now(timezone.utc)
    pricer = Pricer(args.season, args.week, now)
    specs = [parse_line(s, args.mult) for s in args.lines]
    if args.file:
        specs += [parse_line(l.strip(), args.mult) for l in open(args.file) if l.strip() and not l.startswith('#')]
    if args.sleeper or args.slate:
        sl, path = sleeper_slate(args.season, args.slate)
        print(f'Sleeper slate: {len(sl)} NFL player over/unders priced from {os.path.relpath(path, ROOT)}', file=sys.stderr)
        specs += sl
    if not specs:
        ap.error('no lines given')
    rows = [pricer.price(s) for s in specs]
    rows.sort(key=lambda r: (-(r.get('edge') if r.get('edge') is not None else -9), r['player']))
    if args.json:
        print(json.dumps(rows, indent=1))
    else:
        render(rows, pricer.week, now, args.mult)
    if args.record:
        good = [r for r in rows if not r.get('error')]
        wanted = []
        for spec in args.pick:
            words = spec.split()
            for k in range(min(4, len(words) - 1), 0, -1):
                st = stat_key(' '.join(words[-k:]))
                if st:
                    wanted.append((norm_name(' '.join(words[:-k])), st))
                    break
            else:
                raise SystemExit(f"--pick '{spec}': no stat found")
        picked = [r for r in good if (norm_name(r['player']), r['stat']) in wanted]
        missing = [w for w in wanted if not any((norm_name(r['player']), r['stat']) == w for r in good)]
        if missing:
            print(f"warning: --pick not on the slate: {missing}", file=sys.stderr)
        take = [r for r in good if r['source'] == 'typed' or args.record_all
                or (r['edge'] >= args.min_edge and (args.include_flagged or not r['flags']))]
        take = picked + [r for r in take if r not in picked]
        if args.tag:
            for r in (picked if args.pick else take):
                r['tag'] = args.tag
        record(take)


if __name__ == '__main__':
    main()
