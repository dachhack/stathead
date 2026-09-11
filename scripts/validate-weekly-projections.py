#!/usr/bin/env python3
"""Validate one week of weekly-projections-<season>.json against the latest
committed roster / depth-chart / injury snapshots, the games already played
that week, and (optionally) an external projection set.

Everything the weekly builder does NOT look at is checked here: the season
pool assigns teams from an April spine plus manual overrides, caps each
team/position group from a depth-order model that is retrained by hand, and
never reads roster status — so a player can be cut, on IR, on the exempt
list, or retired and still carry a full weekly strip. This script surfaces
those rows so a human (or the daily report) can act on them before kickoff.

Checks, in output order:
  1. Games already played this week vs `playedThrough` (weeks_played() marks a
     whole week as played after its first game).
  2. Team mismatches: projection row team vs nflverse roster team.
  3. Projected players whose roster status is not ACT (RES / CUT / DEV / EXE /
     RET / INA), with points at stake.
  4. Week injury report: Out / Doubtful / Questionable rows with projections.
  5. Depth-chart QB1 per team vs the pool's depth-1 QB.
  6. Backups (gp <= 3) whose conditional per-game rate outranks starters.
  7. Optional: deltas vs an external projection file (Sleeper jsonl from
     get_sleeper_projections, columns full_name/position/team/pts_ppr).
  8. Projection vs actual PPR for teams that have already played.

Run:
  python3 scripts/validate-weekly-projections.py [--week 1] [--sleeper file.jsonl]
Prints markdown to stdout. Exit code is always 0 — this is a report, not a gate.
"""

import argparse
import csv
import gzip
import json
import os
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'public', 'data')
SEASON = 2026
SKILL = ('QB', 'RB', 'WR', 'TE')
# nflverse spells the Rams LA; Sleeper spells them LAR.
TEAM_ALIAS = {'LAR': 'LA'}


def norm(s):
    s = (s or '').lower().replace('.', '').replace("'", '')
    for suf in (' jr', ' sr', ' iii', ' ii', ' iv', ' v'):
        if s.endswith(suf):
            s = s[: -len(suf)]
    return ' '.join(s.split())


def load_json(name):
    with open(os.path.join(DATA, name)) as f:
        return json.load(f)


def iter_csv(base):
    plain = os.path.join(DATA, f'{base}.csv')
    gz = os.path.join(DATA, f'{base}.csv.gz')
    if os.path.exists(plain):
        with open(plain, newline='') as f:
            yield from csv.DictReader(f)
    elif os.path.exists(gz):
        with gzip.open(gz, 'rt') as f:
            yield from csv.DictReader(f)


def table(headers, rows):
    if not rows:
        return '_none_\n'
    out = ['| ' + ' | '.join(headers) + ' |', '|' + '---|' * len(headers)]
    for r in rows:
        out.append('| ' + ' | '.join('' if v is None else str(v) for v in r) + ' |')
    return '\n'.join(out) + '\n'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--week', type=int, default=1)
    ap.add_argument('--sleeper', help='jsonl of Sleeper week projections (full_name, position, team, pts_ppr)')
    ap.add_argument('--min-pts', type=float, default=4.0, help='ignore rows projected below this')
    args = ap.parse_args()
    week = args.week
    wi = week - 1

    doc = load_json(f'weekly-projections-{SEASON}.json')
    players = [p for p in doc['players'] if p['pos'] in SKILL]
    by_key = {(norm(p['name']), p['pos']): p for p in players}

    def wk(p):
        v = p['wk'][wi]
        return v if v is not None else 0.0

    print(f'# Week {week} projection validation — {SEASON}\n')
    print(f'Generated from `weekly-projections-{SEASON}.json` built {doc.get("generatedAt")} '
          f'(season base {doc.get("baseGeneratedAt")}); playedThrough = {doc.get("playedThrough")}.\n')

    # 1. Games played this week ------------------------------------------------
    sched = [g for g in load_json(f'schedule-{SEASON}.json')['games'] if g['week'] == week]
    played_teams = set()
    for r in iter_csv(f'player_stats_{SEASON}'):
        if r.get('week') == str(week) and r.get('season_type') == 'REG':
            played_teams.add(r['team'])
    played = [g for g in sched if g['home'] in played_teams or g['away'] in played_teams]
    print(f'## 1. Games played\n\n{len(played)} of {len(sched)} week-{week} games have stat lines: '
          + ', '.join(f"{g['away']}@{g['home']}" for g in played) + '.')
    if doc.get('playedThrough', 0) >= week and len(played) < len(sched):
        print(f'\n**playedThrough = {doc["playedThrough"]} although {len(sched) - len(played)} games are '
              f'still to be played** — rest-of-season figures (rosPts / rosGames / rosPPG) exclude '
              f'week {week} for every player, and the def-vs-pos blend is already weighting '
              f'{len(played)} game(s) as a full week.')
    print()

    # Roster ---------------------------------------------------------------
    roster = {}
    for r in iter_csv(f'roster_{SEASON}'):
        if r['position'] not in SKILL:
            continue
        if r.get('gsis_id'):
            roster[r['gsis_id']] = r
        roster.setdefault(('n', norm(r['full_name']), r['position']), r)

    def ros(p):
        return roster.get(p.get('gsis')) or roster.get(('n', norm(p['name']), p['pos']))

    # 2. Team mismatches ---------------------------------------------------
    rows = []
    for p in players:
        r = ros(p)
        if r and r['team'] != p['team'] and wk(p) >= 1:
            rows.append((p['name'], p['pos'], p['team'], r['team'], r['status'], wk(p)))
    print('## 2. Team mismatches (projection vs nflverse roster)\n')
    print(table(['player', 'pos', 'projected team', 'roster team', 'status', f'wk{week}'], rows))

    # 3. Roster status -------------------------------------------------------
    rows = []
    for p in players:
        r = ros(p)
        if not r:
            rows.append((p['name'], p['pos'], p['team'], 'NOT ON ANY ROSTER', '', wk(p), p['gp']))
        elif r['status'] != 'ACT':
            rows.append((p['name'], p['pos'], p['team'], r['status'], r.get('status_description_abbr'), wk(p), p['gp']))
    rows = [x for x in rows if x[5] >= args.min_pts]
    rows.sort(key=lambda x: -x[5])
    print(f'## 3. Projected ≥ {args.min_pts:g} pts but not on the active roster\n')
    print('RES = reserve (IR/PUP/NFI), EXE = commissioner exempt, DEV = practice squad, '
          'CUT = waived, RET = retired, INA = inactive for a game already played.\n')
    print(table(['player', 'pos', 'team', 'status', 'code', f'wk{week}', 'gp'], rows))

    # 4. Injury report -------------------------------------------------------
    inj = {}
    for r in iter_csv(f'injuries_{SEASON}'):
        if r.get('week') == str(week) and r['position'] in SKILL:
            inj[r['gsis_id']] = r
            inj[('n', norm(r['full_name']), r['position'])] = r
    rows = []
    for p in players:
        i = inj.get(p.get('gsis')) or inj.get(('n', norm(p['name']), p['pos']))
        if i and (i['report_status'] or 'Did Not' in (i['practice_status'] or '')) and wk(p) >= args.min_pts:
            rows.append((p['name'], p['pos'], p['team'], i['report_status'] or '(no designation yet)',
                         i['practice_status'], i['report_primary_injury'] or i['practice_primary_injury'], wk(p)))
    rows.sort(key=lambda x: -x[6])
    print(f'## 4. Week {week} injury report (designated, or DNP without a designation yet)\n')
    print(table(['player', 'pos', 'team', 'status', 'practice', 'injury', f'wk{week}'], rows))

    # 5. Depth-chart QB1 -----------------------------------------------------
    latest = {}
    dc = defaultdict(list)
    for r in iter_csv(f'depth_charts_{SEASON}'):
        if r.get('pos_abb') != 'QB':
            continue
        t, dt = r['team'], r.get('dt') or ''
        if dt > latest.get(t, ''):
            latest[t] = dt
            dc[t] = []
        if dt == latest[t] and (r.get('pos_rank') or '') == '1':
            dc[t].append(r['player_name'])
    pool_qb1 = {}
    for p in players:
        if p['pos'] == 'QB' and p.get('depth') == 1:
            pool_qb1[p['team']] = p
    rows = []
    for t in sorted(latest):
        pq = pool_qb1.get(t)
        names = dc.get(t, [])
        if pq and names and norm(pq['name']) not in {norm(n) for n in names}:
            rows.append((t, ', '.join(names), pq['name'], wk(pq), pq['gp']))
        elif not pq:
            rows.append((t, ', '.join(names), '(no depth-1 QB in pool)', '', ''))
    print(f'## 5. Depth-chart QB1 disagrees with the pool (depth charts as of {max(latest.values()) if latest else "n/a"})\n')
    print(table(['team', 'depth-chart QB1', 'pool QB1', f'wk{week}', 'gp'], rows))

    # 6. Backups outranking starters -----------------------------------------
    rows = []
    for pos in SKILL:
        ranked = sorted((p for p in players if p['pos'] == pos and wk(p) > 0), key=wk, reverse=True)
        for rank, p in enumerate(ranked, start=1):
            if (p['gp'] or 0) <= 3 and rank <= 24:
                rows.append((pos, rank, p['name'], p['team'], wk(p), p['gp'], p.get('depth')))
    print('## 6. Backups (gp ≤ 3) inside the top 24 at their position\n')
    print('Their weekly points are a per-game rate conditional on playing, computed from a '
          '1–3 game season line; any ranking that ignores gp puts them above starters.\n')
    print(table(['pos', 'rank', 'player', 'team', f'wk{week}', 'gp', 'depth'], rows))

    # 7. External comparison ---------------------------------------------------
    if args.sleeper:
        ext = {}
        with open(args.sleeper) as f:
            for line in f:
                line = line.strip()
                if not line.startswith('{'):
                    continue
                r = json.loads(line)
                if r.get('full_name') and r.get('position') in SKILL:
                    ext[(norm(r['full_name']), r['position'])] = r
        print('## 7. Sleeper comparison\n')
        rows = []
        for k, r in ext.items():
            if k not in by_key and (r.get('pts_ppr') or 0) >= 8:
                rows.append((r['full_name'], r['position'], r.get('team'), r.get('pts_ppr')))
        rows.sort(key=lambda x: -x[3])
        print('### Sleeper ≥ 8 pts, absent from our pool\n')
        print(table(['player', 'pos', 'team', 'sleeper'], rows))
        stats = []
        for pos in SKILL:
            pairs = []
            for p in players:
                if p['pos'] != pos:
                    continue
                r = ext.get((norm(p['name']), pos))
                if r is None:
                    continue
                pairs.append((p, r.get('pts_ppr') or 0))
            both = [(p, s) for p, s in pairs if (p['gp'] or 0) >= 10 and s >= 5]
            if len(both) >= 3:
                xs = [wk(p) for p, _ in both]
                ys = [s for _, s in both]
                n = len(xs)
                mx, my = sum(xs) / n, sum(ys) / n
                cov = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
                sx = sum((x - mx) ** 2 for x in xs) ** 0.5
                sy = sum((y - my) ** 2 for y in ys) ** 0.5
                r_ = cov / (sx * sy) if sx and sy else float('nan')
                mae = sum(abs(x - y) for x, y in zip(xs, ys)) / n
                stats.append((pos, n, f'{r_:.2f}', f'{mx:.1f}', f'{my:.1f}', f'{mae:.1f}'))
            big = sorted(pairs, key=lambda ps: -(wk(ps[0]) - ps[1]))
            over = [(p['name'], p['team'], wk(p), s, f'{wk(p) - s:+.1f}', p['gp'], p.get('depth'))
                    for p, s in big[:8] if wk(p) - s >= 3]
            under = [(p['name'], p['team'], wk(p), s, f'{wk(p) - s:+.1f}', p['gp'], p.get('depth'))
                     for p, s in big[::-1][:8] if s - wk(p) >= 3]
            print(f'### {pos}: we are higher than Sleeper\n')
            print(table(['player', 'team', 'ours', 'sleeper', 'diff', 'gp', 'depth'], over))
            print(f'### {pos}: Sleeper is higher than us\n')
            print(table(['player', 'team', 'ours', 'sleeper', 'diff', 'gp', 'depth'], under))
        print('### Agreement on regular starters (gp ≥ 10, Sleeper ≥ 5)\n')
        print(table(['pos', 'n', 'r', 'mean ours', 'mean sleeper', 'MAE'], stats))

    # 8. Actuals ---------------------------------------------------------------
    rows = []
    for r in iter_csv(f'player_stats_{SEASON}'):
        if r.get('week') != str(week) or r.get('season_type') != 'REG' or r['position'] not in SKILL:
            continue
        p = by_key.get((norm(r['player_display_name']), r['position']))
        act = float(r.get('fantasy_points_ppr') or 0)
        rows.append((r['player_display_name'], r['position'], r['team'],
                     wk(p) if p else None, round(act, 1), (p or {}).get('gp')))
    rows.sort(key=lambda x: -x[4])
    print(f'## 8. Teams already played: projection vs actual PPR\n')
    print(table(['player', 'pos', 'team', 'projected', 'actual', 'gp'], [x for x in rows if x[4] >= 3 or (x[3] or 0) >= 5]))
    have = [x for x in rows if x[3] is not None]
    if have:
        mae = sum(abs(x[3] - x[4]) for x in have) / len(have)
        print(f'\n{len(have)} matched rows: MAE {mae:.1f}, projected total {sum(x[3] for x in have):.0f} '
              f'vs actual {sum(x[4] for x in have):.0f}.')
    missing = [x for x in rows if x[3] is None and x[4] >= 5]
    if missing:
        print('\nScored ≥ 5 with no projection row: ' + ', '.join(f'{x[0]} ({x[2]} {x[1]}, {x[4]})' for x in missing) + '.')
    print()


if __name__ == '__main__':
    main()
