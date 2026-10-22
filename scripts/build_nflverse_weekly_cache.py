#!/usr/bin/env python3
"""Build a compact per-player weekly feature cache from nflverse releases.

Reads four nflverse CSVs for one season and emits a single small JSON that
scripts/train_ktc_timeseries.py consumes:

    stats_player_week_<season>.csv   (weekly player offensive stats)
    snap_counts_<season>.csv          (weekly snap counts & pct)
    depth_charts_<season>.csv         (daily depth chart entries)
    injuries_<season>.csv             (weekly injury reports)

plus nflverse's schedule (games.csv, every season) for the dates each week's
games were all played and the season's calendar. The CSVs are downloaded on
demand from GitHub releases if not present locally. The output JSON is scoped
to offensive positions (QB/RB/WR/TE) and keeps only the columns the KTC
time-series trainer uses for weekly feature extraction — roughly 5-10% the
size of the raw inputs.

One file per season; the trainer loads every nflverse_weekly_*.json it finds
and, at each sample date, uses the season in progress (or the one that just
ended). Rebuild the current season's file weekly during the season
(.github/workflows/retrain-dynasty-forecast.yml does) so the new week's games
reach the forecasts.

Output: public/data/nflverse_weekly_<season>.json

Schema:
  {
    "generatedAt": "2026-10-22T...",
    "season": 2026,
    "calendar": {              # from the schedule
      "seasonStart": "2026-09-10",     # first regular-season game
      "regSeasonEnd": "2027-01-10",    # last regular-season game
      "postSeasonEnd": "2027-02-14"    # Super Bowl (estimated until scheduled)
    },
    "weekCompleteDates": { "1": "2026-09-15", ..., "18": "2027-01-11" },
                               # day after the week's last game; weeks not yet
                               # played carry their scheduled date
    "players": {
      "<norm_name>::<position>": {
        "weeks": [
          {"w": 6, "seasonType": "REG", "team": "KC",
           "offSnaps": 45, "offPct": 0.65,
           "targets": 8, "receptions": 6, "recYards": 82, "recTds": 1,
           "carries": 0, "rushYards": 0, "rushTds": 0,
           "recEpa": 2.1, "rushEpa": 0.0,
           "airYards": 92,
           "injuryStatus": "Full"},
          ...
        ],
        "depthHistory": [
          {"dt": "2026-03-14", "rank": 2},
          {"dt": "2026-10-12", "rank": 1},
          ...
        ]
      },
      ...
    }
  }

Usage:
    python3 scripts/build_nflverse_weekly_cache.py [--season=2026]
        default season: the one in progress or most recently played
        (September onwards is the new season)
    NFLVERSE_RAW_DIR=<dir>   where the raw CSVs are cached (default /tmp/nflverse)
"""
import json
import os
import re
import sys
import time
import urllib.request
from datetime import date, timedelta
from pathlib import Path

import pandas as pd


DATA_DIR = Path('public/data')

# Where to cache raw CSVs before preprocessing. /tmp is fine — the
# preprocessor is idempotent and the intermediate files can be deleted.
RAW_DIR = Path(os.environ.get('NFLVERSE_RAW_DIR', '/tmp/nflverse'))

RELEASES = 'https://github.com/nflverse/nflverse-data/releases/download/'
SCHEDULE_FILE = 'games.csv'   # every season, one file
SEASON_FILES = {
    'stats_player_week_{s}.csv': 'stats_player/stats_player_week_{s}.csv',
    'snap_counts_{s}.csv': 'snap_counts/snap_counts_{s}.csv',
    'depth_charts_{s}.csv': 'depth_charts/depth_charts_{s}.csv',
    'injuries_{s}.csv': 'injuries/injuries_{s}.csv',
}

# nflverse week numbers for the post-season (games.csv game_type → week is
# already numbered this way; kept for the docstring and the sanity check).
POST_SEASON_WEEKS = {'WC': 19, 'DIV': 20, 'CON': 21, 'SB': 22}
# Until the Super Bowl is on the schedule, assume the usual five weeks after
# the last regular-season game (2025: Jan 4 → Feb 8).
SB_AFTER_REG_END_DAYS = 35

OFFENSIVE_POSITIONS = ('QB', 'RB', 'WR', 'TE')


def default_season(today=None):
    today = today or date.today()
    return today.year if today.month >= 9 else today.year - 1


def output_path(season):
    return DATA_DIR / f'nflverse_weekly_{season}.json'


def normalize_name(name):
    """Keep in sync with scripts/train_ktc_timeseries.py::normalize_name."""
    if not name:
        return ''
    s = str(name).lower()
    s = re.sub(r'[^a-z ]', '', s)
    s = re.sub(r'\s+', ' ', s).strip()
    s = re.sub(r' (jr|sr|ii|iii|iv|v)$', '', s)
    return s


def download(url, path):
    print(f'  downloading {url}...')
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=120) as r, open(path, 'wb') as f:
        f.write(r.read())


def ensure_raw_csvs(season):
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    files = {SCHEDULE_FILE: 'schedules/games.csv'}
    files.update({k.format(s=season): v.format(s=season)
                  for k, v in SEASON_FILES.items()})
    for fname, rel in files.items():
        path = RAW_DIR / fname
        # The schedule changes all season (scores, playoff dates): refetch it
        # when the cached copy is more than a day old.
        if path.exists() and path.stat().st_size > 0 and (
                fname != SCHEDULE_FILE
                or time.time() - path.stat().st_mtime < 86400):
            continue
        download(RELEASES + rel, path)


def load_schedule(season):
    """(week_complete_dates, calendar) for `season` from games.csv.

    A week is complete the day after its last game. Weeks not yet played
    carry their scheduled date, so the trainer still treats them as
    unseen until that date passes.
    """
    df = pd.read_csv(RAW_DIR / SCHEDULE_FILE, low_memory=False)
    df = df[df['season'] == season].copy()
    if df.empty:
        raise SystemExit(f'games.csv has no {season} season yet')
    df['gameday'] = pd.to_datetime(df['gameday']).dt.date
    df['week'] = df['week'].astype(int)
    for gt, w in POST_SEASON_WEEKS.items():
        bad = df[(df['game_type'] == gt) & (df['week'] != w)]
        if not bad.empty:
            raise SystemExit(f'{season} {gt} games numbered week '
                             f'{sorted(bad["week"].unique())}, expected {w}')
    wcd = {int(w): d + timedelta(days=1)
           for w, d in df.groupby('week')['gameday'].max().items()}
    reg = df[df['game_type'] == 'REG']
    sb = df[df['game_type'] == 'SB']
    season_start = reg['gameday'].min()
    reg_end = reg['gameday'].max()
    post_end = (sb['gameday'].max() if not sb.empty
                else reg_end + timedelta(days=SB_AFTER_REG_END_DAYS))
    calendar = {'seasonStart': season_start.isoformat(),
                'regSeasonEnd': reg_end.isoformat(),
                'postSeasonEnd': post_end.isoformat()}
    return wcd, calendar


def load_stats(season):
    df = pd.read_csv(RAW_DIR / f'stats_player_week_{season}.csv', low_memory=False)
    df = df[df['position'].isin(OFFENSIVE_POSITIONS)].copy()
    df = df[df['week'].notna()].copy()
    df['week'] = df['week'].astype(int)
    df['norm'] = df['player_display_name'].apply(normalize_name)
    keep = ['norm', 'position', 'week', 'season_type', 'team',
            'targets', 'receptions', 'receiving_yards', 'receiving_tds',
            'receiving_air_yards',
            'carries', 'rushing_yards', 'rushing_tds',
            'receiving_epa', 'rushing_epa',
            'passing_yards', 'passing_tds', 'passing_epa']
    for c in keep:
        if c not in df.columns:
            df[c] = 0
    return df[keep]


def load_snaps(season):
    df = pd.read_csv(RAW_DIR / f'snap_counts_{season}.csv', low_memory=False)
    df = df[df['position'].isin(OFFENSIVE_POSITIONS)].copy()
    df['norm'] = df['player'].apply(normalize_name)
    df['week'] = df['week'].astype(int)
    return df[['norm', 'position', 'week', 'game_type',
               'offense_snaps', 'offense_pct']]


def load_depth_charts(season):
    df = pd.read_csv(RAW_DIR / f'depth_charts_{season}.csv', low_memory=False)
    df = df[df['pos_abb'].isin(OFFENSIVE_POSITIONS)].copy()
    df['norm'] = df['player_name'].apply(normalize_name)
    # Parse date portion from ISO dt strings like "2025-09-06T12:00:00Z"
    df['dt_date'] = df['dt'].astype(str).str[:10]
    # Keep only the highest-priority (lowest rank) entry per (player, pos, date)
    df = df.sort_values(['norm', 'pos_abb', 'dt_date', 'pos_rank'])
    df = df.drop_duplicates(['norm', 'pos_abb', 'dt_date'], keep='first')
    return df[['norm', 'pos_abb', 'dt_date', 'pos_rank']]


def load_injuries(season):
    df = pd.read_csv(RAW_DIR / f'injuries_{season}.csv', low_memory=False)
    df = df[df['position'].isin(OFFENSIVE_POSITIONS)].copy()
    df['norm'] = df['full_name'].apply(normalize_name)
    df['week'] = df['week'].astype(int)
    return df[['norm', 'position', 'week', 'report_status', 'practice_status']]


def build_player_cache(stats, snaps, deps, injs):
    """Assemble the per-player weekly cache with one entry per (name, pos)."""
    # Key the merge by (norm, position) / (norm, pos_abb)
    stats_grouped = stats.groupby(['norm', 'position'])
    snaps_grouped = snaps.groupby(['norm', 'position'])
    injs_grouped = injs.groupby(['norm', 'position'])
    deps_grouped = deps.groupby(['norm', 'pos_abb'])

    all_keys = (
        set(stats_grouped.groups.keys())
        | set(snaps_grouped.groups.keys())
        | set(injs_grouped.groups.keys())
        | {(n, p) for n, p in deps_grouped.groups.keys()}
    )

    players = {}
    for name, pos in all_keys:
        # Merge weekly stats + snaps + injuries into one per-week record
        weeks = {}  # week -> dict
        if (name, pos) in stats_grouped.groups:
            sdf = stats_grouped.get_group((name, pos))
            for _, row in sdf.iterrows():
                w = int(row['week'])
                weeks.setdefault(w, {})
                weeks[w].update({
                    'w': w,
                    'seasonType': str(row.get('season_type', 'REG')),
                    'team': str(row.get('team', '')),
                    'targets': float(row.get('targets') or 0),
                    'receptions': float(row.get('receptions') or 0),
                    'recYards': float(row.get('receiving_yards') or 0),
                    'recTds': float(row.get('receiving_tds') or 0),
                    'airYards': float(row.get('receiving_air_yards') or 0),
                    'carries': float(row.get('carries') or 0),
                    'rushYards': float(row.get('rushing_yards') or 0),
                    'rushTds': float(row.get('rushing_tds') or 0),
                    'recEpa': float(row.get('receiving_epa') or 0),
                    'rushEpa': float(row.get('rushing_epa') or 0),
                    'passYards': float(row.get('passing_yards') or 0),
                    'passTds': float(row.get('passing_tds') or 0),
                    'passEpa': float(row.get('passing_epa') or 0),
                })

        if (name, pos) in snaps_grouped.groups:
            ndf = snaps_grouped.get_group((name, pos))
            for _, row in ndf.iterrows():
                w = int(row['week'])
                weeks.setdefault(w, {})
                weeks[w]['w'] = w
                weeks[w]['offSnaps'] = float(row.get('offense_snaps') or 0)
                weeks[w]['offPct'] = float(row.get('offense_pct') or 0)

        if (name, pos) in injs_grouped.groups:
            idf = injs_grouped.get_group((name, pos))
            for _, row in idf.iterrows():
                w = int(row['week'])
                weeks.setdefault(w, {})
                weeks[w]['w'] = w
                rs = str(row.get('report_status') or '')
                ps = str(row.get('practice_status') or '')
                weeks[w]['injuryStatus'] = rs or ps or 'Unknown'

        # Depth chart: keyed by (name, pos_abb) — same abbreviations
        depth_history = []
        if (name, pos) in deps_grouped.groups:
            ddf = deps_grouped.get_group((name, pos)).sort_values('dt_date')
            # Keep only distinct (date, rank) transitions — collapse runs
            last_rank = None
            for _, row in ddf.iterrows():
                r = int(row['pos_rank']) if pd.notna(row['pos_rank']) else None
                if r is None:
                    continue
                if r != last_rank:
                    depth_history.append({'dt': str(row['dt_date']), 'rank': r})
                    last_rank = r

        key = f'{name}::{pos}'
        players[key] = {
            'weeks': sorted(weeks.values(), key=lambda x: x['w']),
            'depthHistory': depth_history,
        }

    return players


def main(argv):
    season = default_season()
    for a in argv:
        if a.startswith('--season='):
            season = int(a.split('=', 1)[1])
        else:
            raise SystemExit(f'unknown option {a}')

    print(f'Season {season}: ensuring raw nflverse CSVs present in {RAW_DIR}...')
    ensure_raw_csvs(season)

    print('Reading the schedule...')
    wcd, calendar = load_schedule(season)
    played = [w for w, d in wcd.items() if d <= date.today()]
    print(f'  {len(wcd)} weeks scheduled, {len(played)} complete; '
          f'calendar {calendar}')

    print(f'Loading stats_player_week_{season}.csv...')
    stats = load_stats(season)
    print(f'  {len(stats)} rows, {stats["norm"].nunique()} unique offensive players')

    print(f'Loading snap_counts_{season}.csv...')
    snaps = load_snaps(season)
    print(f'  {len(snaps)} rows, {snaps["norm"].nunique()} unique')

    print(f'Loading depth_charts_{season}.csv...')
    deps = load_depth_charts(season)
    print(f'  {len(deps)} rows (offensive, deduped)')

    print(f'Loading injuries_{season}.csv...')
    injs = load_injuries(season)
    print(f'  {len(injs)} rows, {injs["norm"].nunique()} unique')

    print('Merging into per-player cache...')
    players = build_player_cache(stats, snaps, deps, injs)
    weeks_seen = sorted({w['w'] for p in players.values() for w in p['weeks']})
    print(f'  {len(players)} (norm_name, position) entries, '
          f'weeks with data: {weeks_seen[0] if weeks_seen else None}'
          f'-{weeks_seen[-1] if weeks_seen else None}')

    output = {
        'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'season': season,
        'calendar': calendar,
        'weekCompleteDates': {str(k): v.isoformat() for k, v in sorted(wcd.items())},
        'players': players,
    }
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    out = output_path(season)
    with open(out, 'w') as f:
        json.dump(output, f, separators=(',', ':'))
    size_mb = out.stat().st_size / 1024 / 1024
    print(f'Wrote {out} ({size_mb:.2f} MB)')


if __name__ == '__main__':
    main(sys.argv[1:])
