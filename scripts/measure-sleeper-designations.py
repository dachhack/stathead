#!/usr/bin/env python3
"""What Sleeper's live injury tag is worth, by how far before kickoff it is read.

The weekly projections apply Sleeper's status (Questionable / Doubtful / Out)
before the week's official report posts, using the multipliers measured on
OFFICIAL final designations (scripts/measure-injury-designations.py:
Questionable x0.63). A Sleeper tag read on Wednesday is not a final
designation: many clear up by Friday. This measures the tag itself.

Source: the git history of public/data/sleeper-injuries-<season>.json, which
the injury refresh commits every 20 minutes, so each commit is a snapshot.
For every QB/RB/WR/TE game-week tag that Sleeper set after the team's
previous kickoff (the projections' own rule), the status is read at the last
snapshot in each window before the team's kickoff:

  early   3.5+ days out    (Wednesday / Thursday for a Sunday game)
  mid     1.5-3.5 days     (Friday / Saturday)
  late    under 1.5 days   (Saturday night / game day)

Outcome as in measure-injury-designations.py: what he scored that week
against his own baseline, the mean PPR of his OTHER weeks this season where
he played with no official designation (min MIN_BASE_GAMES, baseline >=
MIN_BASE_PPG); no stat row = 0. mult = sum(actual) / sum(baseline), play =
share with a stat row. Also: where the official report ended up for each tag.

Needs the file's git history: a full clone, or GIT_DIR pointed at one
(a --filter=blob:none clone works; blobs are fetched as read).

Run:  [GIT_DIR=<clone>] python3 scripts/measure-sleeper-designations.py [--season 2026] [--ref HEAD]
Writes public/data/sleeper-designation-multipliers-<season>.json (+ printed table).
"""
import argparse
import csv
import gzip
import json
import os
import subprocess
from bisect import bisect_right
from collections import defaultdict
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'public', 'data')
POS = ('QB', 'RB', 'WR', 'TE')
GAMEWEEK = ('Questionable', 'Doubtful', 'Out')
MIN_BASE_GAMES = 3
MIN_BASE_PPG = 5.0
WINDOWS = (('early', 3.5, 99.0), ('mid', 1.5, 3.5), ('late', 0.0, 1.5))


def git(*args):
    return subprocess.run(['git', *args], cwd=ROOT, capture_output=True, text=True, check=True).stdout


def snapshots(season, ref):
    """[(commit time, commit)] for the Sleeper status file, oldest first."""
    path = f'public/data/sleeper-injuries-{season}.json'
    out = []
    for line in git('log', '--reverse', '--format=%H %cI', ref, '--', path).splitlines():
        h, t = line.split()
        out.append((datetime.fromisoformat(t), h))
    return out, path


def kickoffs(season):
    """(team, week) -> kickoff datetime; team -> sorted kickoffs."""
    sched = json.load(open(os.path.join(DATA, f'schedule-{season}.json')))['games']
    ko, by_team = {}, defaultdict(list)
    for g in sched:
        if not g.get('date'):
            continue
        t = datetime.fromisoformat(g['date'])
        for team in (g['home'], g['away']):
            ko[(team, g['week'])] = t
            by_team[team].append(t)
    for v in by_team.values():
        v.sort()
    return ko, by_team


def stat_rows(season):
    """(gsis, week) -> PPR for every played REG week."""
    out = {}
    with gzip.open(os.path.join(DATA, f'player_stats_{season}.csv.gz'), 'rt') as fh:
        for r in csv.DictReader(fh):
            if r.get('season_type') == 'REG' and r.get('position') in POS:
                out[(r['player_id'], int(r['week']))] = float(r.get('fantasy_points_ppr') or 0)
    return out


def official(season):
    """(gsis, week) -> (final report status or '', practice status)."""
    out = {}
    path = os.path.join(DATA, f'injuries_{season}.csv.gz')
    if not os.path.exists(path):
        return out
    with gzip.open(path, 'rt') as fh:
        for r in csv.DictReader(fh):
            if r.get('game_type', 'REG') == 'REG' and (r.get('week') or '').isdigit():
                out[(r.get('gsis_id'), int(r['week']))] = (r.get('report_status') or '', r.get('practice_status') or '')
    return out


def sleeper_to_gsis(season):
    ids = {}
    for name in (f'weekly-projections-{season}.json',):
        try:
            for p in json.load(open(os.path.join(DATA, name)))['players']:
                if p.get('sleeper') and p.get('gsis'):
                    ids[str(p['sleeper'])] = p['gsis']
        except (OSError, ValueError, KeyError):
            pass
    return ids


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--season', type=int, default=2026)
    ap.add_argument('--ref', default='HEAD')
    args = ap.parse_args()
    season = args.season
    snaps, path = snapshots(season, args.ref)
    times = [t for t, _ in snaps]
    ko, by_team = kickoffs(season)
    played = stat_rows(season)
    rep = official(season)
    sid2gsis = sleeper_to_gsis(season)
    last_week = max(w for _, w in played) if played else 0

    # Tags: (gsis, week, window) -> status, from the last snapshot in each window.
    cache = {}

    def snap(h):
        if h not in cache:
            cache[h] = json.loads(git('show', f'{h}:{path}')).get('players', [])
        return cache[h]

    tags = {}
    games = sorted(((team, w), t) for (team, w), t in ko.items() if w <= last_week)
    for (team, week), kick in games:
        prev = [t for t in by_team[team] if t < kick]
        prev_kick = prev[-1] if prev else kick - timedelta(days=7)
        for wname, lo, hi in WINDOWS:
            i = bisect_right(times, kick - timedelta(days=lo)) - 1
            if i < 0 or times[i] <= kick - timedelta(days=hi) or times[i] <= prev_kick:
                continue
            for r in snap(snaps[i][1]):
                if r.get('team') != team or r.get('pos') not in POS or r.get('injury_status') not in GAMEWEEK:
                    continue
                upd = r.get('news_updated') or 0
                if upd and datetime.fromtimestamp(upd / 1000, timezone.utc) <= prev_kick:
                    continue     # last week's tag, not this week's
                g = r.get('gsis_id') or sid2gsis.get(str(r.get('sleeper_id') or ''))
                if g:
                    tags[(g, week, wname)] = r['injury_status']

    # Baselines: other played weeks with no official designation.
    designated = {k for k, (s, _) in rep.items() if s in GAMEWEEK}
    base_pts = defaultdict(list)
    for (g, w), pts in played.items():
        if (g, w) not in designated:
            base_pts[g].append((w, pts))

    cells = defaultdict(lambda: {'n': 0, 'played': 0, 'actual': 0.0, 'base': 0.0, 'final': defaultdict(int)})
    for (g, week, wname), status in tags.items():
        others = [p for w, p in base_pts.get(g, []) if w != week]
        if len(others) < MIN_BASE_GAMES:
            continue
        base = sum(others) / len(others)
        if base < MIN_BASE_PPG:
            continue
        c = cells[(wname, status)]
        c['n'] += 1
        pts = played.get((g, week))
        c['played'] += pts is not None
        c['actual'] += pts or 0.0
        c['base'] += base
        fin = rep.get((g, week), ('', ''))[0] or 'none'
        c['final'][fin if fin in GAMEWEEK else 'none'] += 1

    out = {'season': season, 'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
           'snapshots': len(snaps), 'firstSnapshot': times[0].isoformat() if times else None,
           'weeks': sorted({w for (_, w, _) in tags}), 'windows': {w: [lo, hi] for w, lo, hi in WINDOWS},
           'minBaseGames': MIN_BASE_GAMES, 'minBasePPG': MIN_BASE_PPG, 'cells': {}}
    print(f"Sleeper tags, {season} weeks {out['weeks'][0] if out['weeks'] else '-'}-{out['weeks'][-1] if out['weeks'] else '-'} "
          f"({len(snaps)} snapshots from {out['firstSnapshot'][:10] if times else '-'})\n")
    print('| when read | Sleeper status | n | played | mult | official final: none / Q / D / Out |')
    print('|---|---|---|---|---|---|')
    for wname, _, _ in WINDOWS:
        for status in GAMEWEEK:
            c = cells.get((wname, status))
            if not c or not c['n']:
                continue
            mult = c['actual'] / c['base'] if c['base'] else None
            f = c['final']
            out['cells'][f'{wname}|{status}'] = {'n': c['n'], 'played': round(c['played'] / c['n'], 3),
                                                 'mult': round(mult, 3) if mult is not None else None,
                                                 'final': {k: f.get(k, 0) for k in ('none', 'Questionable', 'Doubtful', 'Out')}}
            print(f"| {wname} | {status} | {c['n']} | {c['played'] / c['n']:.0%} | x{mult:.2f} | "
                  f"{f.get('none', 0)} / {f.get('Questionable', 0)} / {f.get('Doubtful', 0)} / {f.get('Out', 0)} |")
    with open(os.path.join(DATA, f'sleeper-designation-multipliers-{season}.json'), 'w') as fh:
        json.dump(out, fh, indent=1)
        fh.write('\n')


if __name__ == '__main__':
    main()
