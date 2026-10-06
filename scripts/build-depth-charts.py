#!/usr/bin/env python3
"""Build the publishable team depth charts: the newest nflverse snapshot per
team (offense, defense and special teams, every slot and rank), with roster
status, StatHead's depth-order score for the skill positions, and the moves
since the previous snapshot and since a week ago.

Why: the raw nflverse file is 600k rows of twice-daily history, and the
feed encodes a team's three starting receivers as three slots that all
carry the abbreviation WR, each with its own rank 1..n. Any consumer keyed
on team + position + rank collapses them to one receiver. This file keys on
the slot, labels duplicate abbreviations (WR1 / WR2 / WR3 = the first,
second and third receiver slot on the base chart), and is ~2,300 rows.

Source: nflverse depth_charts (CC-BY-4.0; the teams' published charts as
carried by ESPN). Nothing here is a ranking, value or projection, so it can
be shown as is. StatHead's own depthScore / depthRank come from
depth-order-<season>.json (scripts/train_depth_order_model.py).

Inputs (CI's fresh .csv is preferred over the committed .csv.gz):
  public/data/depth_charts_<season>.csv(.gz)   snapshots (dt, team, slot, rank)
  public/data/roster_<season>.csv(.gz)         status (ACT / RES / ...), headshot
  public/data/depth-order-<season>.json        StatHead within-position order

Output: public/data/depth-charts-<season>.json
Run: python3 scripts/build-depth-charts.py [season]
"""

import csv
import gzip
import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'public', 'data')
SEASON = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 2026

GROUP_OF = {'3WR 1TE': 'offense', 'Base 4-3 D': 'defense', 'Base 3-4 D': 'defense', 'Special Teams': 'specialTeams'}
SKILL = ('QB', 'RB', 'WR', 'TE')


def iter_csv_rows(base):
    plain = os.path.join(DATA, f'{base}.csv')
    gz = os.path.join(DATA, f'{base}.csv.gz')
    if os.path.exists(plain):
        with open(plain, newline='') as f:
            yield from csv.DictReader(f)
    elif os.path.exists(gz):
        with gzip.open(gz, 'rt') as f:
            yield from csv.DictReader(f)


def load_json(name):
    path = os.path.join(DATA, name)
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return json.load(f)


def norm(s):
    s = (s or '').lower().replace('.', '').replace("'", '')
    for suf in (' jr', ' sr', ' iii', ' ii', ' iv', ' v'):
        if s.endswith(suf):
            s = s[: -len(suf)]
    return ' '.join(s.split())


def group_of(pos_grp):
    if pos_grp in GROUP_OF:
        return GROUP_OF[pos_grp]
    g = (pos_grp or '').lower()
    if 'special' in g:
        return 'specialTeams'
    return 'defense' if ' d' in g or 'defense' in g else 'offense'


def parse_dt(s):
    try:
        return datetime.fromisoformat(s.replace('Z', '+00:00'))
    except ValueError:
        return None


def main():
    # Snapshots: (team, dt) -> rows. The feed is per team per scrape, so a
    # team's newest chart is its own latest dt, not the file's.
    by_team_dt = defaultdict(list)
    for r in iter_csv_rows(f'depth_charts_{SEASON}'):
        if not r.get('dt') or not r.get('team'):
            continue
        by_team_dt[(r['team'], r['dt'])].append(r)
    if not by_team_dt:
        print('No depth-chart rows; nothing written')
        return
    dts_by_team = defaultdict(list)
    for (t, dt) in by_team_dt:
        dts_by_team[t].append(dt)
    for t in dts_by_team:
        dts_by_team[t].sort()

    # Roster status and headshot by gsis_id, newest week wins.
    roster = {}
    for r in iter_csv_rows(f'roster_{SEASON}'):
        g = r.get('gsis_id')
        if not g:
            continue
        try:
            wk = int(r.get('week') or 0)
        except ValueError:
            wk = 0
        if g not in roster or wk >= roster[g][0]:
            roster[g] = (wk, r.get('status') or None, r.get('headshot_url') or None, r.get('jersey_number') or None)

    # StatHead depth order (skill positions) by normalized name + team + pos.
    order = {}
    for p in (load_json(f'depth-order-{SEASON}.json') or {}).get('players', []):
        order[(norm(p.get('name')), p.get('team'), p.get('pos'))] = (p.get('depthScore'), p.get('teamRank'))

    slot_names = {}
    team_forms = defaultdict(dict)   # team -> group -> formation, from the newest chart

    def chart_rows(team, dt):
        """A team's chart at a snapshot as flat rows with slot labels."""
        rows = by_team_dt.get((team, dt), [])
        # Label duplicate abbreviations within a group by slot order: the
        # 3WR 1TE chart has WR slots 1, 2 and 8 -> WR1, WR2, WR3.
        slots = defaultdict(set)
        for r in rows:
            slots[(group_of(r['pos_grp']), r['pos_abb'])].add(int(r['pos_slot'] or 0))
        label_of = {}
        for (grp, abb), ss in slots.items():
            ordered = sorted(ss)
            for i, s in enumerate(ordered, start=1):
                label_of[(grp, abb, s)] = abb if len(ordered) == 1 else f'{abb}{i}'
        out = []
        for r in rows:
            grp = group_of(r['pos_grp'])
            slot = int(r['pos_slot'] or 0)
            gsis = r.get('gsis_id') or None
            ro = roster.get(gsis) if gsis else None
            od = order.get((norm(r.get('player_name')), team, r['pos_abb'])) if r['pos_abb'] in SKILL else None
            slot_names[(grp, r['pos_abb'], slot)] = r.get('pos_name') or r['pos_abb']
            team_forms[team].setdefault(grp, r['pos_grp'])
            out.append({
                'team': team, 'group': grp, 'slot': slot, 'pos': r['pos_abb'],
                'label': label_of[(grp, r['pos_abb'], slot)],
                'rank': int(r['pos_rank'] or 0), 'name': r.get('player_name'),
                'gsis_id': gsis, 'espn_id': r.get('espn_id') or None,
                'status': ro[1] if ro else None,
                'depthScore': od[0] if od else None, 'depthRank': od[1] if od else None,
            })
        out.sort(key=lambda x: ({'offense': 0, 'defense': 1, 'specialTeams': 2}[x['group']], x['slot'], x['rank']))
        # The chart's rank runs across a position, not within a slot: the
        # three receiver slots carry ranks 1/4/7, 2/5/8 and 3/6, so the WR2
        # slot's starter is rank 2. slotRank is the order within the slot
        # and starter means first in the slot.
        counter = defaultdict(int)
        for x in out:
            k = (x['group'], x['slot'])
            counter[k] += 1
            x['slotRank'] = counter[k]
            x['starter'] = counter[k] == 1
        return out

    def ref_snapshot(team, latest, days=None):
        """The team's previous snapshot, or its newest snapshot at least
        `days` days before the latest one."""
        dts = dts_by_team[team]
        if days is None:
            older = [d for d in dts if d < latest]
            return older[-1] if older else None
        cutoff = parse_dt(latest) - timedelta(days=days)
        older = [d for d in dts if (parse_dt(d) or cutoff) <= cutoff]
        return older[-1] if older else None

    def diff(team, cur_rows, ref_dt, since_label):
        """Slot-level moves between a reference snapshot and the current one."""
        if not ref_dt:
            return []
        ref_rows = chart_rows(team, ref_dt)
        key = lambda x: (x['group'], x['pos'], x['slot'], x['gsis_id'] or norm(x['name']))
        cur = {key(x): x for x in cur_rows}
        ref = {key(x): x for x in ref_rows}
        out = []
        for k, x in cur.items():
            r = ref.get(k)
            if r is None:
                kind = 'added'
            elif r['rank'] != x['rank']:
                kind = 'up' if x['rank'] < r['rank'] else 'down'
            else:
                continue
            out.append({'team': team, 'group': x['group'], 'label': x['label'], 'pos': x['pos'], 'slot': x['slot'],
                        'name': x['name'], 'gsis_id': x['gsis_id'], 'from': r['rank'] if r else None, 'to': x['rank'],
                        'kind': kind, 'newStarter': x['starter'] and not (r and r['starter']),
                        'since': ref_dt, 'window': since_label})
        for k, r in ref.items():
            if k not in cur:
                out.append({'team': team, 'group': r['group'], 'label': r['label'], 'pos': r['pos'], 'slot': r['slot'],
                            'name': r['name'], 'gsis_id': r['gsis_id'], 'from': r['rank'], 'to': None,
                            'kind': 'removed', 'newStarter': False, 'since': ref_dt, 'window': since_label})
        out.sort(key=lambda c: (c['group'], c['slot'], c['to'] if c['to'] is not None else 99))
        return out

    rows, changes, changes7d, teams = [], [], [], {}
    for team in sorted(dts_by_team):
        latest = dts_by_team[team][-1]
        cur = chart_rows(team, latest)
        rows.extend(cur)
        forms = dict(team_forms[team])
        prev = ref_snapshot(team, latest)
        week = ref_snapshot(team, latest, days=7)
        teams[team] = {'snapshot': latest, 'previousSnapshot': prev, 'weekAgoSnapshot': week,
                       'formation': forms, 'players': len(cur)}
        changes.extend(diff(team, cur, prev, 'previous'))
        changes7d.extend(diff(team, cur, week, '7d'))

    latest_all = max(t['snapshot'] for t in teams.values())
    doc = {
        'season': SEASON,
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'snapshot': latest_all,
        'source': 'nflverse depth_charts (CC-BY-4.0): the teams\' published depth charts as carried by ESPN. Attribute "nflverse".',
        'note': (
            'Each team\'s newest depth chart, every slot and rank, for offense (3WR 1TE '
            'base chart), defense (the team\'s base front) and special teams. rows are '
            'keyed by team + group + slot: a chart lists three receiver slots that all '
            'carry pos WR, so label numbers duplicate abbreviations by slot order (WR1 / '
            'WR2 / WR3 = first, second, third receiver slot; each has its own rank 1..n). '
            'rank is the chart\'s rank across the position (the WR slots carry 1/4/7, '
            '2/5/8, 3/6, so a team\'s WR order is the rank order); slotRank is the order '
            'within the slot and starter = first in the slot. status is the nflverse roster status (ACT, '
            'RES = injured reserve, EXE, DEV = practice squad...). depthScore / depthRank '
            'are StatHead\'s own within-position depth-order model for QB/RB/WR/TE, '
            'carried for comparison with the team\'s chart. changes = slot-level moves '
            'between each team\'s previous snapshot and its newest (kind up / down / '
            'added / removed, newStarter when a player became rank 1); changes7d = the '
            'same against the team\'s newest snapshot at least 7 days older. teams[T] '
            'gives the snapshot times and formations. Snapshots are taken twice a day.'
        ),
        'slotNames': {f'{g}|{a}|{sl}': n for (g, a, sl), n in sorted(slot_names.items())},
        'teams': teams,
        'rows': rows,
        'changes': changes,
        'changes7d': changes7d,
    }
    out = os.path.join(DATA, f'depth-charts-{SEASON}.json')
    with open(out, 'w') as fh:
        json.dump(doc, fh, separators=(',', ':'))
        fh.write('\n')
    print(f'Wrote {out}: {len(teams)} teams, {len(rows)} rows, {len(changes)} moves since previous snapshot, '
          f'{len(changes7d)} over 7 days; newest snapshot {latest_all}')


if __name__ == '__main__':
    main()
