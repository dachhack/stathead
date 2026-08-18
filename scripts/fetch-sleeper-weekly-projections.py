#!/usr/bin/env python3
"""Fetch Sleeper's per-week projections for a season — the external benchmark
the in-season model is scored against.

Sleeper publishes a full projected stat line per player per week (attempts,
yards, targets, receptions, TDs), which is what makes it a like-for-like
comparison rather than a fantasy-points-only one. Rows are slimmed to the
stats StatHead projects, and players with no projected volume are dropped.

⚠️ Provenance caveat: each row carries Sleeper's `last_modified`, and for
completed weeks that timestamp often lands *after* kickoff. Sleeper does not
publish a frozen pre-game snapshot, so treat their numbers as "the projection
as Sleeper last left it", not as a guaranteed pre-game line. The evaluation
script reports the timestamp distribution so the caveat stays visible, and
scores every model on the same player-weeks.

Usage:
  python3 scripts/fetch-sleeper-weekly-projections.py [--season 2025] [--weeks 1-18]

Output:
  public/data/sleeper-weekly-proj-<season>.json
"""

import argparse
import json
import os
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'public', 'data')

POSITIONS = ('QB', 'RB', 'WR', 'TE')

# Sleeper stat key -> our stat key.
STAT_MAP = {
    'pass_att': 'passAtt', 'pass_cmp': 'passComp', 'pass_yd': 'passYds',
    'pass_td': 'passTD', 'pass_int': 'int',
    'rush_att': 'rushAtt', 'rush_yd': 'rushYds', 'rush_td': 'rushTD',
    'rec_tgt': 'tgt', 'rec': 'rec', 'rec_yd': 'recYds', 'rec_td': 'recTD',
    'pts_ppr': 'pprPts',
}


def fetch_week(season, week, retries=4):
    pos = '&'.join(f'position[]={p}' for p in POSITIONS)
    url = (f'https://api.sleeper.app/projections/nfl/{season}/{week}'
           f'?season_type=regular&{pos}&order_by=pts_ppr')
    delay = 2
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'stathead/1.0'})
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = json.load(resp)
            return data if isinstance(data, list) else list(data.values())
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            if attempt == retries - 1:
                print(f'  week {week}: giving up ({e})')
                return []
            time.sleep(delay)
            delay *= 2
    return []


def slim(rows, week):
    out = []
    for r in rows:
        stats = r.get('stats') or {}
        pl = r.get('player') or {}
        pos = pl.get('position') or (pl.get('fantasy_positions') or [None])[0]
        if pos not in POSITIONS:
            continue
        line = {}
        for src, dst in STAT_MAP.items():
            v = stats.get(src)
            if v:
                line[dst] = round(float(v), 2)
        if not line:
            continue      # no projected volume — Sleeper lists the whole league
        name = pl.get('full_name') or ' '.join(
            filter(None, [pl.get('first_name'), pl.get('last_name')])).strip()
        out.append({
            'week': week,
            'sleeper': str(r.get('player_id') or pl.get('player_id') or ''),
            'name': name,
            'pos': pos,
            'team': pl.get('team') or pl.get('team_abbr'),
            'injury': pl.get('injury_status') or None,
            'gp': stats.get('gp'),
            'lastModified': r.get('last_modified'),
            **line,
        })
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--season', type=int, default=2025)
    ap.add_argument('--weeks', default='1-18', help='e.g. 1-18 or 5')
    args = ap.parse_args()

    if '-' in args.weeks:
        lo, hi = (int(x) for x in args.weeks.split('-'))
        weeks = range(lo, hi + 1)
    else:
        weeks = [int(args.weeks)]

    rows = []
    for w in weeks:
        got = slim(fetch_week(args.season, w), w)
        print(f'  week {w}: {len(got)} projected players')
        rows.extend(got)
        time.sleep(0.5)

    if not rows:
        raise SystemExit('No Sleeper projections fetched — nothing written.')

    stamps = [r['lastModified'] for r in rows if r.get('lastModified')]
    out = {
        'season': args.season,
        'source': 'Sleeper API (api.sleeper.app/projections/nfl)',
        'fetchedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'note': (
            "Sleeper's per-week projected stat lines, slimmed to the stats "
            'StatHead projects and filtered to players with any projected '
            'volume. Used as the external benchmark in '
            'weekly-backtest-<season>.json. Sleeper does not publish a frozen '
            'pre-game snapshot; `lastModified` is when they last touched the '
            'row, which for completed weeks can be after kickoff.'
        ),
        'lastModifiedRange': [min(stamps), max(stamps)] if stamps else None,
        'players': rows,
    }
    path = os.path.join(DATA, f'sleeper-weekly-proj-{args.season}.json')
    with open(path, 'w') as f:
        json.dump(out, f, separators=(',', ':'))
    kb = os.path.getsize(path) / 1024
    print(f'Wrote {path} ({kb:.0f} KB): {len(rows)} player-weeks, '
          f'{len({r["week"] for r in rows})} weeks')


if __name__ == '__main__':
    main()
