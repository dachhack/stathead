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
  2. Team mismatches: projection row team vs the nflverse roster, the newest
     depth chart and Sleeper's player list (the roster lags trades/signings).
  3. Projected players whose roster status is not ACT (RES / CUT / DEV / EXE /
     RET / INA), with points at stake.
  4. Week injury report: Out / Doubtful / Questionable rows with projections.
  5. Depth-chart QB1 per team vs the pool's depth-1 QB, and teams with more
     than one depth-1 QB in the pool.
  6. Backups (gp <= 3) whose conditional per-game rate outranks starters.
  7. Optional: deltas vs an external projection file (Sleeper jsonl from
     get_sleeper_projections, columns full_name/position/team/pts_ppr).
  8. Projection vs actual PPR for teams that have already played.

Run:
  python3 scripts/validate-weekly-projections.py [--week 1|auto] [--sleeper file.jsonl]
      [--out public/data/weekly-projections-audit.md] [--json public/data/weekly-projections-audit.json]
Prints markdown to stdout (or --out). --week auto = the first week whose games
are not all played. --json writes the counts the daily report surfaces.
Exit code is always 0 — this is a report, not a gate.
"""

import argparse
import csv
import gzip
import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone

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
    ap.add_argument('--week', default='auto', help='NFL week, or "auto" (first week not fully played)')
    ap.add_argument('--sleeper', help='jsonl of Sleeper week projections (full_name, position, team, pts_ppr)')
    ap.add_argument('--min-pts', type=float, default=4.0, help='ignore rows projected below this')
    ap.add_argument('--out', help='write the markdown here instead of stdout')
    ap.add_argument('--json', help='write a JSON summary of the counts here')
    args = ap.parse_args()

    doc = load_json(f'weekly-projections-{SEASON}.json')
    if args.week == 'auto':
        week = int(doc.get('currentWeek') or (doc.get('playedThrough') or 0) + 1)
    else:
        week = int(args.week)
    wi = week - 1
    summary = {'season': SEASON, 'week': week, 'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
               'projectionsBuilt': doc.get('generatedAt'), 'playedThrough': doc.get('playedThrough')}
    if args.out:
        sys.stdout = open(args.out, 'w')
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
    summary['gamesPlayed'] = len(played)
    summary['gamesScheduled'] = len(sched)
    summary['playedThroughWrong'] = bool(doc.get('playedThrough', 0) >= week and len(played) < len(sched))
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

    # Depth charts: each team's newest snapshot. A player on two teams' newest
    # charts (one team has not republished since a move) goes with the newer.
    dc_latest = {}
    dc_rows = []
    for r in iter_csv(f'depth_charts_{SEASON}'):
        t, dt = r['team'], r.get('dt') or ''
        if dt > dc_latest.get(t, ''):
            dc_latest[t] = dt
        dc_rows.append(r)
    dc_team = {}   # gsis or ('n', name) -> (dt, team)
    for r in dc_rows:
        t, dt = r['team'], r.get('dt') or ''
        if dt != dc_latest[t]:
            continue
        for k in ([r['gsis_id']] if r.get('gsis_id') else []) + [('n', norm(r['player_name']))]:
            if dt > dc_team.get(k, ('', ''))[0]:
                dc_team[k] = (dt, t)
    del dc_rows

    def dc_of(p):
        hit = dc_team.get(p.get('gsis')) or dc_team.get(('n', norm(p['name'])))
        return hit[1] if hit else None

    # Sleeper players snapshot (team None = free agent).
    try:
        slp = load_json('sleeper-players.json')
    except (OSError, ValueError):
        slp = {}
    slp = slp.get('players', slp) if isinstance(slp, dict) else slp
    slp = list(slp.values()) if isinstance(slp, dict) else (slp or [])
    slp_by = {}
    for s in slp:
        if not isinstance(s, dict) or s.get('position') not in SKILL:
            continue
        if s.get('player_id'):
            slp_by[('s', str(s['player_id']))] = s
        if s.get('gsis_id'):
            slp_by[('g', s['gsis_id'])] = s

    def slp_of(p):
        s = slp_by.get(('s', str(p.get('sleeper') or ''))) or slp_by.get(('g', p.get('gsis') or ''))
        if s is None:
            return None
        return TEAM_ALIAS.get(s.get('team'), s.get('team')) or 'FA'

    # 2. Team mismatches ---------------------------------------------------
    # The weekly builder takes teams from the nflverse roster, which can lag a
    # trade or signing by a day or more, so checking against the roster alone
    # misses exactly the moves that matter. Compare against all three sources:
    # nflverse roster, the newest depth chart, and Sleeper's player list.
    rows = []
    for p in players:
        if wk(p) < 1:
            continue
        r = ros(p)
        src = {'roster': r['team'] if r else None, 'depth chart': dc_of(p), 'Sleeper': slp_of(p)}
        off = [k for k, v in src.items() if v and v != p['team']]
        if off:
            rows.append((p['name'], p['pos'], p['team'], src['roster'], src['depth chart'], src['Sleeper'],
                         r['status'] if r else None, wk(p), off))
    rows.sort(key=lambda x: -x[7])
    summary['teamMismatches'] = [
        f'{x[0]} ({x[2]} {x[1]}; ' + ', '.join(f'{k} {dict(zip(("roster", "depth chart", "Sleeper"), x[3:6]))[k]}'
                                               for k in x[8]) + f'; {x[7]})'
        for x in rows]
    print('## 2. Team mismatches (projection vs nflverse roster / depth chart / Sleeper)\n')
    print('A row is listed when any source puts the player on a different team (FA = Sleeper '
          'lists no team). The weekly builder follows the nflverse roster, so a move the roster '
          'has not caught up with shows here as a depth-chart and/or Sleeper disagreement.\n')
    print(table(['player', 'pos', 'projected team', 'roster', 'depth chart', 'Sleeper', 'status', f'wk{week}'],
                [x[:8] for x in rows]))

    # 3. Roster status -------------------------------------------------------
    rows = []
    for p in players:
        r = ros(p)
        if p.get('active') is False and wk(p) == 0:
            continue   # the builder already zeroed this row from roster status
        if not r:
            rows.append((p['name'], p['pos'], p['team'], 'NOT ON ANY ROSTER', '', wk(p), p['gp']))
        elif r['status'] not in ('ACT', 'INA'):   # INA = on the 53, inactive for a game already played
            rows.append((p['name'], p['pos'], p['team'], r['status'], r.get('status_description_abbr'), wk(p), p['gp']))
    rows = [x for x in rows if x[5] >= args.min_pts]
    rows.sort(key=lambda x: -x[5])
    summary['inactiveWithPoints'] = [f'{x[0]} ({x[2]} {x[1]}, {x[3]}, {x[5]})' for x in rows]
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
    summary['injuryFlags'] = [f'{x[0]} ({x[2]} {x[1]}, {x[3]}, {x[6]})' for x in rows]
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
    pool_qb1 = defaultdict(list)
    for p in players:
        if p['pos'] == 'QB' and p.get('depth') == 1:
            pool_qb1[p['team']].append(p)
    rows = []
    for t in sorted(set(latest) | set(pool_qb1)):
        pqs = pool_qb1.get(t, [])
        names = dc.get(t, [])
        if len(pqs) > 1:
            # Two depth-1 QBs: usually a QB who moved teams but is still on his
            # old team's row (the roster lags), so both carry starter volume.
            rows.append((t, ', '.join(names), ' + '.join(q['name'] for q in pqs) + f' (all {len(pqs)} depth-1)',
                         ' / '.join(str(wk(q)) for q in pqs), ' / '.join(str(q['gp']) for q in pqs)))
        elif pqs and names and norm(pqs[0]['name']) not in {norm(n) for n in names}:
            rows.append((t, ', '.join(names), pqs[0]['name'], wk(pqs[0]), pqs[0]['gp']))
        elif not pqs:
            rows.append((t, ', '.join(names), '(no depth-1 QB in pool)', '', ''))
    summary['qb1Disagreements'] = [f'{x[0]}: chart {x[1]} / pool {x[2]}' for x in rows]
    print(f'## 5. Depth-chart QB1 disagrees with the pool (depth charts as of {max(latest.values()) if latest else "n/a"})\n')
    print(table(['team', 'depth-chart QB1', 'pool QB1', f'wk{week}', 'gp'], rows))

    # 6. Backups outranking starters -----------------------------------------
    rows = []
    for pos in SKILL:
        ranked = sorted((p for p in players if p['pos'] == pos and wk(p) > 0), key=wk, reverse=True)
        for rank, p in enumerate(ranked, start=1):
            if (p['gp'] or 0) <= 3 and rank <= 24:
                rows.append((pos, rank, p['name'], p['team'], wk(p), p['gp'], p.get('depth')))
    summary['backupsInTop24'] = [f'{x[2]} ({x[3]} {x[0]}{x[1]})' for x in rows]
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
        summary['actualsMatched'] = len(have)
        summary['actualsMAE'] = round(mae, 2)
        print(f'\n{len(have)} matched rows: MAE {mae:.1f}, projected total {sum(x[3] for x in have):.0f} '
              f'vs actual {sum(x[4] for x in have):.0f}.')
    missing = [x for x in rows if x[3] is None and x[4] >= 5]
    summary['scoredWithoutRow'] = [f'{x[0]} ({x[2]} {x[1]}, {x[4]})' for x in missing]
    if missing:
        print('\nScored ≥ 5 with no projection row: ' + ', '.join(f'{x[0]} ({x[2]} {x[1]}, {x[4]})' for x in missing) + '.')
    print()
    if args.json:
        with open(args.json, 'w') as f:
            json.dump(summary, f, indent=1)
            f.write('\n')


if __name__ == '__main__':
    main()
