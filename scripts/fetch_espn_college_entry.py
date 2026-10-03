#!/usr/bin/env python3
"""College entry season for players without a recruiting record (ESPN).

The devy models date a player's age and years in college from his recruiting
class. Without one (an unrated recruit, a walk-on, a JUCO or lower-division
transfer: about a quarter of the top 1,000 on the board) they fell back to his
first CFBD season, which misses redshirt years and every season below FCS:
Trinidad Chambliss (Ferris State, then Ole Miss) read as 19.9 years old.

ESPN's college athlete ids are CFBD's, and it keeps two facts that bound the
entry season from above:
  - the seasons in his stat log, across divisions (Ferris State 2024 for
    Chambliss, where CFBD starts at Ole Miss 2025);
  - his class (1 = freshman ... 4 = senior) for the current season, while he
    is active: he entered no later than season - class + 1.
scripts/devy_features.py takes the earliest of those and his first CFBD
season. Class is a floor (a redshirt or sixth-year still reads as a senior),
so ages stay conservative.

Writes public/data/cfbd/college-entry.json:
  {"season": <current college season>, "players": {cfbdId: {"log": first
   stat-log season or null, "cls": class or null, "clsSeason": season the
   class is for, or null}}}
Facts only (seasons, class); nothing ESPN rates or ranks.

Fetches skill-position players (QB/RB/WR/TE) with CFBD seasons and no linked
recruit that are not in the file yet, and refreshes players active in the
last two seasons once per season (their class moves). Two calls per player;
the first run is ~15k players (~15 minutes), later runs only the new ones.

Also writes public/data/cfbd/rosters-<season>.json: who is on an FBS or FCS
roster this season (ESPN team rosters, ~280 calls), {"season", "fetchedAt",
"teams": <rosters read>, "players": {cfbdId: ESPN team id}}. In season the
devy value model drops a player who is on no roster and has no stats this
season: off the team (left, out of eligibility, gone below FCS), not a devy
asset (issue #540: ~750 such players were ranked, Devonte Ross #95 in 1QB).

Usage: python3 scripts/fetch_espn_college_entry.py [--limit N] [--refresh] [--no-rosters]
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from devy_features import CFBD, POSITIONS, _first_seasons, load_recruits  # noqa: E402

OUT = CFBD / 'college-entry.json'
BASE = 'https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/athletes/'


def get(url: str):
    for i in range(3):
        try:
            with urllib.request.urlopen(url, timeout=20) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
        except Exception:  # noqa: BLE001 -- retry transient network errors
            pass
        time.sleep(1 + i)
    return None


def fetch(pid: str, season: int) -> dict:
    a = get(BASE + pid) or {}
    log = get(BASE + pid + '/statisticslog') or {}
    seasons = sorted(int(e['season']['$ref'].split('seasons/')[1][:4]) for e in log.get('entries', [])
                     if '$ref' in (e.get('season') or {}))
    cls = (a.get('experience') or {}).get('years')
    active = bool(a.get('active')) and (not seasons or seasons[-1] >= season - 1)
    return {'log': seasons[0] if seasons else None,
            'cls': int(cls) if cls and active else None,
            'clsSeason': season if cls and active else None}


TEAMS = ('https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons/{season}'
         '/types/2/groups/{group}/teams?limit=300')
ROSTER = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams/{team}/roster?limit=300'
GROUPS = (80, 81)  # FBS, FCS
MIN_TEAMS = 200    # a roster file with fewer teams read is incomplete: write nothing


def fetch_rosters(season: int) -> None:
    teams = set()
    for g in GROUPS:
        d = get(TEAMS.format(season=season, group=g)) or {}
        for it in d.get('items', []):
            teams.add(it['$ref'].split('/teams/')[1].split('?')[0])
    players, read = {}, 0

    def one(team):
        d = get(ROSTER.format(team=team)) or {}
        return team, [a['id'] for grp in d.get('athletes', []) for a in grp.get('items', []) if a.get('id')]

    with cf.ThreadPoolExecutor(12) as ex:
        for team, ids in ex.map(one, sorted(teams)):
            if ids:
                read += 1
            for i in ids:
                players[str(i)] = team
    print(f'rosters {season}: {read}/{len(teams)} teams, {len(players)} players')
    if read < MIN_TEAMS:
        print(f'::warning::only {read} rosters read; not writing')
        return
    out = CFBD / f'rosters-{season}.json'
    out.write_text(json.dumps({'season': season, 'fetchedAt': time.strftime('%Y-%m-%dT%H:%MZ', time.gmtime()),
                               'teams': read, 'players': dict(sorted(players.items()))}, separators=(',', ':')))
    print(f'wrote {out}')


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, default=0, help='fetch at most N players (testing)')
    ap.add_argument('--refresh', action='store_true', help='refetch every recently active player')
    ap.add_argument('--no-rosters', action='store_true', help='skip the roster fetch')
    args = ap.parse_args()

    idx = _first_seasons()
    season = max(y for v in idx.values() for _, y, _, _ in v)  # newest season on disk
    rec = load_recruits(range(2000, season + 4))
    linked = set(rec['player_id'])
    # Newest CFBD season per player (to know who is active).
    want = {}
    for v in idx.values():
        for pid, first, _, pos in v:
            if pos in POSITIONS and pid not in linked:
                want[pid] = first
    last = {}
    for p in sorted(CFBD.glob('player-season-*.json'))[-2:]:
        for r in json.load(open(p)):
            last[str(r['player_id'])] = int(r['season'])

    doc = json.load(open(OUT)) if OUT.exists() else {'season': season, 'players': {}}
    have = doc['players']
    new_season = doc.get('season') != season
    todo = [pid for pid in want if pid not in have
            or ((args.refresh or new_season) and (want[pid] >= season - 1 or last.get(pid, 0) >= season - 1))]
    if args.limit:
        todo = todo[:args.limit]
    print(f'{len(want)} players without a linked recruit; fetching {len(todo)}')
    done = 0
    with cf.ThreadPoolExecutor(12) as ex:
        for pid, row in zip(todo, ex.map(lambda p: fetch(p, season), todo)):
            have[pid] = row
            done += 1
            if done % 1000 == 0:
                print(f'  {done}/{len(todo)}')
    doc['season'] = season
    doc['players'] = dict(sorted(have.items()))
    OUT.write_text(json.dumps(doc, separators=(',', ':')))
    print(f'wrote {OUT} ({len(have)} players)')
    if not args.no_rosters:
        fetch_rosters(season)


if __name__ == '__main__':
    main()
