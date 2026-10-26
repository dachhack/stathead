#!/usr/bin/env python3
"""Price pick lines against the week's StatHead projections, and record them.

A line is a player, a stat, a number and the payout per leg (the app's
multiplier, default 1.78). Each is priced from the player's week stat line
(public/data/weekly-projections-2026.json: statsPG split for the week's
matchup) and the stat-line simulation of scripts/score-weekly-projections.py
(gamma volume, binomial receptions, summed gamma yards, Poisson TDs):
P(over) = the share of draws above the line. The lean is the side with the
higher probability; the edge is that probability against the payout's
break-even (1 / mult), and ev the return per unit at the payout.

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

--record appends the priced lines to public/data/pick-log.json with the
timestamp, so the scorer can grade them once the week is final (the pick
card in the daily report: hit rate, calibration by confidence, return).

Usage:
  python3 scripts/price-lines.py "Germie Bernard recYds 54.5" "Jaylin Noel recYds 27.5 @1.78" ...
  python3 scripts/price-lines.py --file lines.txt [--mult 1.78] [--week 7] [--record] [--json]
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
from collections import defaultdict
from datetime import datetime, timezone

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'public', 'data')
_spec = importlib.util.spec_from_file_location('scorer', os.path.join(ROOT, 'scripts', 'score-weekly-projections.py'))
sc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sc)

DEFAULT_MULT = 1.78
DRAWS = 20000
STAT_ALIASES = {
    'recyds': 'recYds', 'receivingyards': 'recYds', 'recyards': 'recYds', 'receivingyds': 'recYds',
    'rushyds': 'rushYds', 'rushingyards': 'rushYds', 'rushyards': 'rushYds', 'rushingyds': 'rushYds',
    'passyds': 'passYds', 'passingyards': 'passYds', 'passyards': 'passYds', 'passingyds': 'passYds',
    'rec': 'rec', 'receptions': 'rec', 'catches': 'rec', 'tgt': 'tgt', 'targets': 'tgt',
    'rushatt': 'rushAtt', 'carries': 'rushAtt', 'rushattempts': 'rushAtt',
    'passtd': 'passTD', 'passingtds': 'passTD', 'passtds': 'passTD', 'passingtouchdowns': 'passTD',
    'rushrecyds': 'rushRecYds', 'rush+recyds': 'rushRecYds', 'rush+recyards': 'rushRecYds', 'rushandrecyds': 'rushRecYds',
    'scrimmageyards': 'rushRecYds', 'rushrecyards': 'rushRecYds',
    'passrushyds': 'passRushYds', 'pass+rushyds': 'passRushYds', 'pass+rushyards': 'passRushYds', 'passandrushyds': 'passRushYds',
    'anytd': 'anyTD', 'anytimetd': 'anyTD', 'rushrectd': 'anyTD', 'rush+rectd': 'anyTD', 'rushrectds': 'anyTD',
}
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
    """'Player Name stat 54.5 [@1.78]' or 'Player Name|stat|54.5[|1.78]'."""
    if '|' in spec:
        parts = [x.strip() for x in spec.split('|')]
        if len(parts) < 3:
            raise SystemExit(f"bad line '{spec}'")
        return parts[0], parse_stat(parts[1]), float(parts[2]), float(parts[3]) if len(parts) > 3 and parts[3] else default_mult
    m = LINE_RE.match(spec)
    if not m:
        raise SystemExit(f"bad line '{spec}' (expected 'Player stat 54.5 [@1.78]')")
    name, stat = split_name_stat(m['body'])
    return name, stat, float(m['line']), float(m['mult']) if m['mult'] else default_mult


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


def price(players, bands, act_stats, schedule, spec, week, default_mult, now, games_played):
    name, stat, line, mult = parse_line(spec, default_mult)
    p = find_player(players, name)
    row = {'player': name, 'stat': stat, 'line': line, 'mult': mult, 'week': week}
    if not p:
        return {**row, 'error': 'not in the weekly feed (check the name; a player with no row has no line here)'}
    row.update({'player': p['name'], 'gsis': p.get('gsis'), 'pos': p['pos'], 'team': p['team']})
    wl, m = week_line(p, week)
    params = (bands.get('simulation') or {}).get('params', {}).get(p['pos'])
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
    p_lean = max(p_over, p_under)
    breakeven = 1 / mult
    flags = []
    st = status_for(p, week)
    if st:
        flags.append(f'status:{st}')
    # A position-mate's game-week call (IR / PUP / suspension are season-long
    # absences the pool already prices; a Questionable / Doubtful / Out mate
    # is this week's news).
    mates = [q for q in players if q['team'] == p['team'] and q['pos'] == p['pos'] and q is not p and (q.get('ppg') or 0) >= 4]
    mate_st = [f"{q['name']} {status_for(q, week)}" for q in mates if status_for(q, week) in MATE_FLAG]
    if mate_st:
        flags.append('mate:' + '; '.join(mate_st))
    f = (p.get('roleAdj') or {}).get('factor')
    if f and abs(f - 1) >= ROLE_FLAG:
        flags.append(f'role:x{f:.2f}')
    gp = games_played.get(p.get('gsis'), 0)
    if gp < FORM_GAMES:
        flags.append(f'games:{gp}')
    else:
        recent = [sc.pick_actual(act_stats.get((p['gsis'], w)), stat) for w in range(week - 1, 0, -1)
                  if (p['gsis'], w) in act_stats][:FORM_GAMES]
        if len(recent) >= FORM_GAMES and proj > 0:
            avg = float(np.mean(recent))
            if abs(avg - proj) / proj >= FORM_FLAG:
                flags.append(f'form:last{len(recent)} {avg:.1f} vs proj {proj:.1f}')
    for v, lo in THIN.items():
        if v in {('tgt' if c in ('rec', 'recYds', 'recTD', 'tgt') else 'rushAtt' if c in ('rushYds', 'rushTD', 'rushAtt')
                  else 'passAtt') for c in comps} and wl.get(v, 0) < lo:
            flags.append(f'thin:{v} {wl.get(v, 0):.1f}')
    if kicked_off(schedule, p['team'], week, now):
        flags.append('started')
    return {**row, 'proj': round(proj, 1), 'median': round(float(np.median(x)), 1), 'pOver': round(p_over, 3),
            'pUnder': round(p_under, 3), 'lean': lean, 'pLean': round(p_lean, 3), 'breakeven': round(breakeven, 3),
            'edge': round(p_lean - breakeven, 3), 'ev': round(p_lean * mult - 1, 3), 'flags': flags,
            'matchup': round(m, 2), 'recordedAt': now.isoformat(timespec='seconds')}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('lines', nargs='*', help="'Player stat 54.5 [@1.78]'")
    ap.add_argument('--file', help='one line per row, same syntax')
    ap.add_argument('--mult', type=float, default=DEFAULT_MULT, help='payout per leg when a line gives none')
    ap.add_argument('--week', type=int, help='NFL week (default: the feed\'s currentWeek)')
    ap.add_argument('--season', type=int, default=2026)
    ap.add_argument('--record', action='store_true', help='append the priced lines to public/data/pick-log.json')
    ap.add_argument('--json', action='store_true', help='print JSON rows instead of a table')
    args = ap.parse_args()
    specs = list(args.lines)
    if args.file:
        specs += [l.strip() for l in open(args.file) if l.strip() and not l.startswith('#')]
    if not specs:
        ap.error('no lines given')
    doc = json.load(open(os.path.join(DATA, f'weekly-projections-{args.season}.json')))
    bands = json.load(open(os.path.join(DATA, 'weekly-projections-bands.json')))
    schedule = json.load(open(os.path.join(DATA, f'schedule-{args.season}.json')))
    act_stats = sc.load_actual_stats(args.season)
    games_played = defaultdict(int)
    for (g, _w) in act_stats:
        games_played[g] += 1
    week = args.week or int(doc.get('currentWeek') or doc.get('playedThrough', 0) + 1)
    now = datetime.now(timezone.utc)
    players = [p for p in doc['players'] if p.get('pos') in sc.POS and p.get('wk')]
    rows = [price(players, bands, act_stats, schedule, s, week, args.mult, now, games_played) for s in specs]
    if args.json:
        print(json.dumps(rows, indent=1))
    else:
        print(f"Week {week} pick lines priced {now.strftime('%Y-%m-%d %H:%M')} UTC (break-even at {args.mult}x = {1 / args.mult:.1%})\n")
        print('| player | pos | stat | line | proj | median | P(over) | lean | P(lean) | edge | EV/unit | flags |')
        print('|---|---|---|---|---|---|---|---|---|---|---|---|')
        for r in rows:
            if r.get('error'):
                print(f"| {r['player']} | | {r['stat']} | {r['line']} | — | — | — | — | — | — | — | {r['error']} |")
                continue
            print(f"| {r['player']} | {r['pos']} | {r['stat']} | {r['line']} | {r['proj']} | {r['median']} | {r['pOver']:.0%} | "
                  f"{r['lean']} | {r['pLean']:.0%} | {r['edge']:+.1%} | {r['ev']:+.2f} | {'; '.join(r['flags']) or '—'} |")
    if args.record:
        good = [r for r in rows if not r.get('error')]
        log = {'note': 'Pick lines priced by scripts/price-lines.py --record, graded by the weekly scorer. '
                       'The line and payout are the user\'s own inputs; everything else is StatHead output.', 'picks': []}
        if os.path.exists(sc.PICK_LOG):
            try:
                log = json.load(open(sc.PICK_LOG))
            except ValueError:
                pass
        existing = {(p.get('gsis'), p.get('week'), p.get('stat'), p.get('line')) for p in log['picks']}
        added = 0
        for r in good:
            key = (r.get('gsis'), r['week'], r['stat'], r['line'])
            if key in existing:
                continue
            log['picks'].append(r)
            existing.add(key)
            added += 1
        json.dump(log, open(sc.PICK_LOG, 'w'), indent=1)
        print(f"\nrecorded {added} new pick(s) in {os.path.relpath(sc.PICK_LOG, ROOT)} ({len(log['picks'])} total)", file=sys.stderr)


if __name__ == '__main__':
    main()
