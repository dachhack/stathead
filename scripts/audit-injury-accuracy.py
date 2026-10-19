#!/usr/bin/env python3
"""Replay the weekly board as it stood at each kickoff and check its injury
calls against who actually played.

For every finished 2026 game this takes the last committed
public/data/weekly-projections-2026.json from before kickoff (git history),
applies the site's availability logic (src/lib/injuryMult.ts and
src/components/WeeklyProjectionsView.tsx: roster status, official report,
Sleeper live status, game-day inactives, QB starter calls) and compares the
displayed PPR points with the player's actual line from the newest file
(`act`, null = did not play).

Who played comes from nflverse snap counts (any offensive or special-teams
snap), since a player who took snaps without touching the ball has no line.
Games whose snap counts are not posted yet are skipped. Depth-2+ backup lines
are left out: the board hides them unless a QB call names him.

  caught     did not play, shown as 0 (out / inactive / roster status)
  missed     did not play, shown >= MISS_PTS at kickoff
    unflagged  ... with nothing on him, or a game-day "active" call: the
               board's failures. A Questionable without a game-day call is a
               priced coin flip (x0.63), counted as missed but not unflagged.
  zeroed     shown as 0, played and scored >= MISS_PTS

Usage: python3 scripts/audit-injury-accuracy.py [--weeks=4-6] [--json=out.json]
       (default: the last finished week and the current one)
Run from the repo root on a full clone (it reads git history). Checked
2026-10-19 over weeks 1-6: 15 unflagged misses in week 1 (before Sleeper
statuses and game-day calls), 1-2 a week from week 4, all fringe lines.
"""
from __future__ import annotations

import csv
import io
import json
import re
import subprocess
import sys
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone

FILE = 'public/data/weekly-projections-2026.json'
SCHEDULE = 'public/data/schedule-2026.json'
MISS_PTS = 5.0  # a start/sit-relevant line

# src/lib/injuryMult.ts
Q_BY_PRACTICE = {'Full': 0.8, 'Limited': 0.64, 'DNP': 0.39}
ACTIVE_Q_BY_PRACTICE = {'Full': 0.91, 'Limited': 0.88, 'DNP': 0.77}
QB_START_P = {'firm': 0.95, 'likely': 0.85}
QB_NOT_START = 0.05


def injury_mult(status, practice=None):
    s = (status or '').lower()
    if s == 'questionable':
        return Q_BY_PRACTICE.get(practice or '', 0.63)
    if s == 'doubtful':
        return 0.0
    if re.fullmatch(r'out|ir|pup|injured reserve|sus|nfi|cov', s):
        return 0.0
    return 1.0


def active_mult(status, practice=None):
    s = (status or '').lower()
    if s == 'questionable':
        return ACTIVE_Q_BY_PRACTICE.get(practice or '', 0.88)
    if s == 'doubtful':
        return 0.58
    return 1.0


def board(doc, week):
    """name|team -> (shown PPR points, what the site showed as the reason)."""
    players = doc['players']
    cur = doc.get('currentWeek')
    named = {}
    for p in players:
        c = p.get('qbc') if p['pos'] == 'QB' and p.get('active') is not False else None
        if not c or c.get('week') != week or c.get('call') not in QB_START_P:
            continue
        at = str(c.get('at') or '')
        if p['team'] not in named or at > named[p['team']][2]:
            named[p['team']] = [p['name'], QB_START_P[c['call']], at]
    for team, n in named.items():
        for p in players:
            if p['team'] != team or p['pos'] != 'QB' or p['name'] == n[0] or p.get('backup'):
                continue
            gd, inj, slp = p.get('gd') or {}, p.get('inj') or {}, p.get('slp') or {}
            if (p.get('active') is False or (gd.get('week') == week and gd.get('call') == 'inactive')
                    or (inj.get('week') == week and injury_mult(inj.get('status'), inj.get('practice')) == 0)
                    or (slp.get('week') == week and injury_mult(slp.get('status')) == 0)):
                n[1] = 1.0
    out = {}
    for p in players:
        wk = p.get('wk') or []
        raw = wk[week - 1] if week - 1 < len(wk) else None
        if raw is None:
            continue
        inactive = p.get('active') is False and (cur is None or week >= cur)
        official = p.get('inj') if p.get('inj') and not inactive and week >= p['inj']['week'] else None
        slp = p.get('slp')
        sleeper = slp if (not official or official['week'] != week) and slp and not inactive and slp.get('week') == week else None
        inj = {'status': sleeper['status'], 'week': week, 'src': 'Sleeper'} if sleeper else (
            dict(official, src='report') if official else None)
        inj_current = bool(inj) and inj['week'] == week
        gd = p.get('gd') if p.get('gd') and not inactive and p['gd'].get('week') == week else None
        practice = inj.get('practice') if inj else None
        if gd:
            m = 0.0 if gd.get('call') == 'inactive' else active_mult(inj['status'] if inj_current else None, practice)
        else:
            m = injury_mult(inj['status'], practice) if inj_current else 1.0
        pts = raw * m if (inj_current or gd) else raw
        if inactive:
            pts = 0.0  # the builder zeroes these weeks already; be explicit
        t = named.get(p['team']) if p['pos'] == 'QB' and not inactive else None
        role = None
        if not t:
            q = p.get('qbc') or {}
            if p['pos'] == 'QB' and not inactive and not p.get('backup') and q.get('week') == week and q.get('call') == 'not':
                role = 'not'
        elif t[0] == p['name']:
            role = 'named' if p.get('backup') or (inj_current and m < 1) else None
        elif not p.get('backup'):
            role = 'benched'
        if role == 'named' and not p.get('backup') and inj:
            pts = max(pts, raw * t[1] * active_mult(inj['status'], practice))
        elif role:
            pts *= t[1] if role == 'named' else (1 - t[1]) if role == 'benched' else QB_NOT_START
        why = ('roster ' + str(p.get('status'))) if inactive else (
            f"game day {gd['call']}" if gd else
            f"{inj['status']} ({inj['src']})" if inj_current else
            f"wk{inj['week']} {inj['status']} (stale, not applied)" if inj else 'no designation')
        if role:
            why += f', QB call {role}'
        # The board hides depth-2+ lines (per-game rates if he plays) unless
        # a QB call names him, so they are not a start/sit call.
        hidden = bool(p.get('backup')) and role != 'named'
        out[f"{p['name']}|{p['team']}"] = (pts, why, p['pos'], raw, hidden)
    return out


SNAPS_URL = 'https://github.com/nflverse/nflverse-data/releases/download/snap_counts/snap_counts_2026.csv'


def norm(name):
    n = re.sub(r"[.'\u2019-]", '', name.lower())
    n = re.sub(r'\s+(jr|sr|ii|iii|iv|v)$', '', n)
    return re.sub(r'\s+', ' ', n).strip()


def load_snaps():
    """(norm name, team, week) for everyone with a snap, and the games
    (week|away|home) that have snap counts at all."""
    try:
        text = open('public/data/snap_counts_2026.csv').read()
    except OSError:
        req = urllib.request.Request(SNAPS_URL, headers={'User-Agent': 'stathead-audit/1.0'})
        with urllib.request.urlopen(req, timeout=120) as r:
            text = r.read().decode()
    played, games = set(), set()
    for r in csv.DictReader(io.StringIO(text)):
        if r.get('game_type') != 'REG':
            continue
        wk = int(r['week'])
        _, _, away, home = r['game_id'].split('_')
        games.add(f'{wk}|{away}|{home}')
        if float(r.get('offense_snaps') or 0) + float(r.get('st_snaps') or 0) > 0:
            played.add((norm(r['player']), r['team'], wk))
            # PFR spells some first names in full (Kenneth Gainwell): also
            # key on the surname, used only when it is unique on the team.
            played.add(('~' + norm(r['player']).split(' ')[-1], r['team'], wk, r['position']))
    return played, games


def git(*args):
    return subprocess.run(['git', *args], capture_output=True, text=True, check=True).stdout


def main():
    args = dict(a.lstrip('-').split('=', 1) for a in sys.argv[1:] if '=' in a)
    latest = json.load(open(FILE))
    played_through = latest.get('playedThrough') or 0
    cur = latest.get('currentWeek') or played_through + 1
    lo, hi = (args.get('weeks') or f'{max(1, played_through)}-{min(cur, 18)}').split('-')
    weeks = range(int(lo), int(hi) + 1)
    actual = {f"{p['name']}|{p['team']}": p for p in latest['players']}

    commits = []  # (epoch, sha), oldest first
    for line in git('log', '--format=%H %ct', '--', FILE).splitlines():
        sha, ct = line.split()
        commits.append((int(ct), sha))
    commits.sort()

    def snapshot_before(ts):
        best = None
        for ct, sha in commits:
            if ct >= ts:
                break
            best = sha
        return best

    games = json.load(open(SCHEDULE))['games']
    played, snapped_games = load_snaps()
    cache = {}
    report = {'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'), 'missPts': MISS_PTS, 'weeks': {}}
    for week in weeks:
        rows, n_games, pending = [], 0, 0
        for g in games:
            if g['week'] != week or not g.get('date'):
                continue
            ko = int(datetime.fromisoformat(g['date']).timestamp())
            sha = snapshot_before(ko)
            if not sha:
                continue
            if sha not in cache:
                cache[sha] = json.loads(git('show', f'{sha}:{FILE}'))
            doc = cache[sha]
            shown = board(doc, week)
            gid = f"{week}|{g['away']}|{g['home']}"
            if gid not in snapped_games:
                pending += 1  # not played, or snap counts not posted yet
                continue
            n_games += 1
            for key, (pts, why, pos, raw, hidden) in shown.items():
                team = key.split('|')[1]
                if hidden or team not in (g['home'], g['away']) or pos in ('K', 'DST', 'DL', 'LB', 'DB'):
                    continue
                a = actual.get(key)
                if not a:
                    continue
                act = (a.get('act') or [None] * 18)[week - 1]
                name = norm(key.split('|')[0])
                surname_unique = sum(1 for k in shown if k.split('|')[1] == team
                                     and norm(k.split('|')[0]).split(' ')[-1] == name.split(' ')[-1]) == 1
                if act is None and ((name, team, week) in played or (
                        surname_unique and ('~' + name.split(' ')[-1], team, week, pos) in played)):
                    act = 0.0  # took snaps, no stat line
                rows.append({'name': key.split('|')[0], 'team': team, 'pos': pos, 'shown': round(pts, 2),
                             'healthy': round(raw, 2), 'why': why, 'actual': act,
                             'snapshotAgeMin': round((ko - next(ct for ct, s in commits if s == sha)) / 60)})
        missed = [r for r in rows if r['actual'] is None and r['shown'] >= MISS_PTS]
        zeroed = [r for r in rows if r['actual'] is not None and r['shown'] == 0 and r['actual'] >= MISS_PTS]
        flagged = [r for r in rows if r['actual'] is None and 0 < r['shown'] < MISS_PTS and r['healthy'] >= MISS_PTS]
        caught = [r for r in rows if r['actual'] is None and r['shown'] == 0 and r['healthy'] >= MISS_PTS]
        unflagged = [r for r in missed if not r['why'].startswith('Questionable')]
        snap_age = max((r['snapshotAgeMin'] for r in rows), default=None)
        if not n_games:
            continue
        report['weeks'][week] = {
            'games': n_games, 'gamesPending': pending, 'rows': len(rows), 'caught': len(caught),
            'discounted': len(flagged), 'missed': missed, 'unflagged': len(unflagged), 'zeroed': zeroed,
            'maxSnapshotAgeMin': snap_age,
        }
        print(f'Week {week} ({n_games} games, {pending} pending): {len(rows)} skill players with a line; '
              f'DNP with a {MISS_PTS:g}+ healthy line: {len(caught)} zeroed, {len(flagged)} discounted, '
              f'{len(missed)} missed ({len(unflagged)} unflagged); {len(zeroed)} zeroed but played; '
              f'oldest pre-kickoff snapshot {snap_age} min')
        for r in sorted(missed, key=lambda r: -r['shown']):
            print(f"   missed  {r['name']} ({r['team']} {r['pos']}) shown {r['shown']}: {r['why']}; snapshot {r['snapshotAgeMin']} min before kickoff")
        for r in sorted(zeroed, key=lambda r: -r['actual']):
            print(f"   zeroed  {r['name']} ({r['team']} {r['pos']}) scored {r['actual']}: {r['why']}")
    if args.get('json'):
        with open(args['json'], 'w') as f:
            json.dump(report, f, indent=1)


if __name__ == '__main__':
    main()
