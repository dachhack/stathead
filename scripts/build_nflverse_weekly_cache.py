#!/usr/bin/env python3
"""Build a compact per-player weekly feature cache from nflverse releases.

Reads four nflverse CSVs for the current (2025-26) season and emits a
single small JSON that scripts/train_ktc_timeseries.py consumes:

    stats_player_week_2025.csv   (weekly player offensive stats)
    snap_counts_2025.csv          (weekly snap counts & pct)
    depth_charts_2025.csv         (daily depth chart entries)
    injuries_2025.csv             (weekly injury reports)

The CSVs are downloaded on demand from GitHub releases if not present
locally. The output JSON is scoped to offensive positions (QB/RB/WR/TE)
and keeps only the columns the KTC time-series trainer uses for weekly
feature extraction — roughly 5-10% the size of the raw inputs.

Output: public/data/nflverse_weekly_2025.json

Schema:
  {
    "generatedAt": "2026-04-11T...",
    "season": 2025,
    "weekCompleteDates": { "1": "2025-09-09", ..., "22": "2026-02-10" },
    "players": {
      "<norm_name>::<position>": {
        "weeks": [
          {"w": 6, "seasonType": "REG", "team": "KC",
           "offSnaps": 45, "offPct": 0.65,
           "targets": 8, "receptions": 6, "recYards": 82, "recTds": 1,
           "carries": 0, "rushYards": 0, "rushTds": 0,
           "recEpa": 2.1, "rushEpa": 0.0,
           "airYards": 92, "redZoneTouches": 1,
           "injuryStatus": "Full"},
          ...
        ],
        "depthHistory": [
          {"dt": "2025-09-06", "rank": 2},
          {"dt": "2025-10-12", "rank": 1},
          ...
        ]
      },
      ...
    }
  }

Usage:
    source /tmp/lgb-verify/bin/activate
    python3 scripts/build_nflverse_weekly_cache.py
"""
import json
import os
import re
import sys
import time
import urllib.request
from datetime import date
from pathlib import Path

import pandas as pd


DATA_DIR = Path('public/data')
OUTPUT_PATH = DATA_DIR / 'nflverse_weekly_2025.json'

# Where to cache raw CSVs before preprocessing. /tmp is fine — the
# preprocessor is idempotent and the intermediate files can be deleted.
RAW_DIR = Path('/tmp/nflverse')

NFLVERSE_URLS = {
    'stats_player_week_2025.csv':
        'https://github.com/nflverse/nflverse-data/releases/download/'
        'stats_player/stats_player_week_2025.csv',
    'snap_counts_2025.csv':
        'https://github.com/nflverse/nflverse-data/releases/download/'
        'snap_counts/snap_counts_2025.csv',
    'depth_charts_2025.csv':
        'https://github.com/nflverse/nflverse-data/releases/download/'
        'depth_charts/depth_charts_2025.csv',
    'injuries_2025.csv':
        'https://github.com/nflverse/nflverse-data/releases/download/'
        'injuries/injuries_2025.csv',
}

# 2025-26 NFL week → calendar date when all games for that week are
# complete (day after MNF, hand-encoded from the public schedule).
# Weeks 19-22 are post-season. After Feb 10 2026 there is no further
# weekly data — features derived from the season stay frozen for the
# remainder of the KTC rolling window.
WEEK_COMPLETE_DATES = {
    1:  date(2025, 9, 9),
    2:  date(2025, 9, 16),
    3:  date(2025, 9, 23),
    4:  date(2025, 9, 30),
    5:  date(2025, 10, 7),
    6:  date(2025, 10, 14),
    7:  date(2025, 10, 21),
    8:  date(2025, 10, 28),
    9:  date(2025, 11, 4),
    10: date(2025, 11, 11),
    11: date(2025, 11, 18),
    12: date(2025, 11, 25),
    13: date(2025, 12, 2),
    14: date(2025, 12, 9),
    15: date(2025, 12, 16),
    16: date(2025, 12, 23),
    17: date(2025, 12, 30),
    18: date(2026, 1, 6),
    19: date(2026, 1, 13),   # Wildcard
    20: date(2026, 1, 20),   # Divisional
    21: date(2026, 1, 27),   # Conference
    22: date(2026, 2, 10),   # Super Bowl
}

OFFENSIVE_POSITIONS = ('QB', 'RB', 'WR', 'TE')


def normalize_name(name):
    """Keep in sync with scripts/train_ktc_timeseries.py::normalize_name."""
    if not name:
        return ''
    s = str(name).lower()
    s = re.sub(r'[^a-z ]', '', s)
    s = re.sub(r'\s+', ' ', s).strip()
    s = re.sub(r' (jr|sr|ii|iii|iv|v)$', '', s)
    return s


def ensure_raw_csvs():
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    for fname, url in NFLVERSE_URLS.items():
        path = RAW_DIR / fname
        if path.exists() and path.stat().st_size > 0:
            continue
        print(f'  downloading {url}...')
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=120) as r, open(path, 'wb') as f:
                f.write(r.read())
        except Exception as e:
            print(f'    FAILED: {e}')
            raise


def load_stats():
    df = pd.read_csv(RAW_DIR / 'stats_player_week_2025.csv', low_memory=False)
    df = df[df['position'].isin(OFFENSIVE_POSITIONS)].copy()
    df = df[df['week'].notna()].copy()
    df['week'] = df['week'].astype(int)
    df['norm'] = df['player_display_name'].apply(normalize_name)
    # Red-zone touches: stats_player_week exposes rushing_red_zone_carries
    # and receiving_red_zone_targets in some seasons. Fall back to sum of
    # carries_inside_10 / targets_inside_10 if present, else 0.
    rz_cols = [c for c in df.columns if 'red_zone' in c or 'inside_' in c]
    keep = ['norm', 'position', 'week', 'season_type', 'team',
            'targets', 'receptions', 'receiving_yards', 'receiving_tds',
            'receiving_air_yards',
            'carries', 'rushing_yards', 'rushing_tds',
            'receiving_epa', 'rushing_epa',
            'passing_yards', 'passing_tds', 'passing_epa']
    for c in keep:
        if c not in df.columns:
            df[c] = 0
    return df[keep + rz_cols]


def load_snaps():
    df = pd.read_csv(RAW_DIR / 'snap_counts_2025.csv', low_memory=False)
    df = df[df['position'].isin(OFFENSIVE_POSITIONS)].copy()
    df['norm'] = df['player'].apply(normalize_name)
    df['week'] = df['week'].astype(int)
    return df[['norm', 'position', 'week', 'game_type',
               'offense_snaps', 'offense_pct']]


def load_depth_charts():
    df = pd.read_csv(RAW_DIR / 'depth_charts_2025.csv', low_memory=False)
    df = df[df['pos_abb'].isin(OFFENSIVE_POSITIONS)].copy()
    df['norm'] = df['player_name'].apply(normalize_name)
    # Parse date portion from ISO dt strings like "2025-09-06T12:00:00Z"
    df['dt_date'] = df['dt'].astype(str).str[:10]
    # Keep only the highest-priority (lowest rank) entry per (player, pos, date)
    df = df.sort_values(['norm', 'pos_abb', 'dt_date', 'pos_rank'])
    df = df.drop_duplicates(['norm', 'pos_abb', 'dt_date'], keep='first')
    return df[['norm', 'pos_abb', 'dt_date', 'pos_rank']]


def load_injuries():
    df = pd.read_csv(RAW_DIR / 'injuries_2025.csv', low_memory=False)
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


def main():
    print('Ensuring raw nflverse CSVs present...')
    ensure_raw_csvs()

    print('Loading stats_player_week_2025.csv...')
    stats = load_stats()
    print(f'  {len(stats)} rows, {stats["norm"].nunique()} unique offensive players')

    print('Loading snap_counts_2025.csv...')
    snaps = load_snaps()
    print(f'  {len(snaps)} rows, {snaps["norm"].nunique()} unique')

    print('Loading depth_charts_2025.csv...')
    deps = load_depth_charts()
    print(f'  {len(deps)} rows (offensive, deduped)')

    print('Loading injuries_2025.csv...')
    injs = load_injuries()
    print(f'  {len(injs)} rows, {injs["norm"].nunique()} unique')

    print('Merging into per-player cache...')
    players = build_player_cache(stats, snaps, deps, injs)
    print(f'  {len(players)} (norm_name, position) entries')

    output = {
        'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'season': 2025,
        'weekCompleteDates': {str(k): v.isoformat()
                               for k, v in WEEK_COMPLETE_DATES.items()},
        'players': players,
    }
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_PATH, 'w') as f:
        json.dump(output, f, separators=(',', ':'))
    size_mb = OUTPUT_PATH.stat().st_size / 1024 / 1024
    print(f'Wrote {OUTPUT_PATH} ({size_mb:.2f} MB)')


if __name__ == '__main__':
    main()
