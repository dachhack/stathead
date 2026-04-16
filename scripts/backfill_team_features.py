#!/usr/bin/env python3
"""
Backfill formation + positional target-share features into the training cache.

The nflverse PBP CSVs don't contain `offense_personnel` at all, and the
legacy buildFeatureMatrix code's receiver position lookup via priorByName
misses rookies and new vets. PR #114 fixed both bugs in the TS pipeline,
but the fix only takes effect on a full cache rebuild — which `npm run
build:features` can't complete in this environment (Node fetch timeouts
on nflverse release URLs, while curl works fine).

This script does a surgical backfill using curl for downloads:

  For each season 2010-2025:
    1. Fetch roster_{S}.csv for name→team and name→position lookups.
    2. Fetch roster_{S-1}.csv for position fallback.
    3. Fetch play_by_play_{S-1}.csv (~100 MB) and aggregate per-team:
         - teamRBTargetRate, teamTETargetRate, teamWRTargetRate
         - teamRBTargetsPerGame, teamTETargetsPerGame
       using the roster-based name→position map (the bug fix).
    4. Fetch pbp_participation_{S-1}.csv (~50 MB) and aggregate per-team:
         - team11Rate, team12Rate, team13Rate, team21Rate, team22Rate, team10Rate
         - teamWR3PlusOnField, team2PlusTEOnField
       reading the offense_personnel field (which EXISTS in participation
       but not in PBP — that's the other half of the bug fix).
    5. For each training cache row in season S, look up the player's team
       via the roster map and write the new feature values in-place.

Downloads cached to /tmp/nflverse-cache so re-runs are fast. Expected
total download: ~2.5 GB for 16 seasons.

Usage:
    python3 scripts/backfill_team_features.py
    python3 scripts/backfill_team_features.py --seasons 2018,2019,2020
"""

import csv
import io
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

CACHE_PATH = Path('public/data/training-rows-cache-v43.json')
FEATURE_STORE_COACHING = Path('public/data/feature-store/coaching.json')
# Per-team feature aggregates derived from PBP/participation. Committed to
# git so a re-backfill without network access still works.
AGGREGATES_PATH = Path('public/data/team-features-backfill.json')
# Raw downloads. .nflverse-cache/ is gitignored (~2 GB) but persists across
# runs so we don't re-download each time. /tmp used to be the default but
# /tmp is periodically cleared, defeating the purpose.
DL_CACHE = Path('.nflverse-cache')
NFLVERSE = 'https://github.com/nflverse/nflverse-data/releases/download'
DEFAULT_SEASONS = list(range(2010, 2026))
SKILL_POSITIONS = {'QB', 'RB', 'WR', 'TE'}

# Target feature keys we're going to (re)populate
PERSONNEL_KEYS = [
    'team11Rate', 'team12Rate', 'team13Rate',
    'team21Rate', 'team22Rate', 'team10Rate',
    'teamWR3PlusOnField', 'team2PlusTEOnField',
]
TARGET_RATE_KEYS = [
    'teamRBTargetRate', 'teamTETargetRate', 'teamWRTargetRate',
    'teamRBTargetsPerGame', 'teamTETargetsPerGame',
]


def normalize_name(s):
    if not s:
        return ''
    s = s.lower().replace('.', '').replace("'", '').strip()
    # Strip common suffixes so training-cache rows like "Travis Etienne Jr."
    # match rosters that use "Travis Etienne".
    for suffix in (' jr', ' sr', ' iii', ' iv', ' ii'):
        if s.endswith(suffix):
            s = s[: -len(suffix)].strip()
            break
    return s


def curl_cached(subpath: str, dest_name: str) -> Path | None:
    """Download via curl (Node fetch times out). Cached in /tmp/nflverse-cache."""
    DL_CACHE.mkdir(parents=True, exist_ok=True)
    dest = DL_CACHE / dest_name
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    url = f'{NFLVERSE}/{subpath}'
    print(f'  curl {dest_name}...', end=' ', flush=True)
    t0 = time.time()
    r = subprocess.run(
        ['curl', '-sL', '--max-time', '300', '-o', str(dest), '-w', '%{http_code} %{size_download}', url],
        capture_output=True, text=True,
    )
    elapsed = time.time() - t0
    if r.returncode != 0:
        print(f'FAILED (curl rc={r.returncode})')
        if dest.exists():
            dest.unlink()
        return None
    parts = r.stdout.strip().split()
    http_code = parts[0] if parts else '?'
    size_mb = int(parts[1]) / 1024 / 1024 if len(parts) > 1 else 0
    if http_code != '200':
        print(f'FAILED (http={http_code})')
        if dest.exists():
            dest.unlink()
        return None
    print(f'ok {size_mb:.0f}MB in {elapsed:.0f}s')
    return dest


def read_csv_dict(path: Path):
    """Read a CSV as list of dicts. Handles quoting properly."""
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        return list(csv.DictReader(f))


def build_roster_maps(season: int):
    """Fetch current + prior rosters for three lookups:
      - name_to_team: normalized name → team (for matching training cache rows)
      - name_to_pos:  normalized name → position (fallback receiver classifier)
      - gsis_to_pos:  gsis_id → position (primary receiver classifier —
                      PBP's receiver_player_name uses abbreviated format
                      like "Mi.Carter" which doesn't match rosters' full
                      names, but receiver_player_id is the gsis_id which
                      joins cleanly).
    """
    name_to_team = {}
    name_to_pos = {}
    gsis_to_pos = {}

    for offset, precedence in [(0, True), (-1, False)]:
        dest = curl_cached(
            f'rosters/roster_{season + offset}.csv',
            f'roster_{season + offset}.csv',
        )
        if dest is None:
            continue
        try:
            rosters = read_csv_dict(dest)
        except Exception as e:
            print(f'  failed to read {dest.name}: {e}')
            continue
        for r in rosters:
            name = normalize_name(r.get('full_name') or r.get('player_name'))
            if not name:
                continue
            team = r.get('team') or ''
            pos = r.get('position') or ''
            gsis = r.get('gsis_id') or ''
            if pos in SKILL_POSITIONS:
                if precedence or name not in name_to_pos:
                    name_to_pos[name] = pos
                if gsis and (precedence or gsis not in gsis_to_pos):
                    gsis_to_pos[gsis] = pos
            if team and (precedence or name not in name_to_team):
                name_to_team[name] = team

    return name_to_team, name_to_pos, gsis_to_pos


def aggregate_scheme(pbp_path: Path, gsis_to_pos: dict, name_to_pos: dict):
    """Aggregate per-team scheme features from PBP.

    Receiver position lookup uses gsis_id (receiver_player_id field in PBP)
    with fallback to abbreviated-name matching if needed. The abbreviated
    name format ("Mi.Carter") doesn't match rosters directly, so fallback
    is rarely productive — gsis_id carries the real join.
    """
    scheme = {}
    games = {}
    id_hits = 0
    id_misses = 0

    with open(pbp_path, 'r', encoding='utf-8', errors='replace') as f:
        reader = csv.DictReader(f)
        for play in reader:
            team = play.get('posteam')
            if not team:
                continue
            play_type = play.get('play_type')
            if play_type not in ('pass', 'run'):
                continue
            if team not in scheme:
                scheme[team] = {
                    'rb_targets': 0, 'te_targets': 0, 'wr_targets': 0, 'total_targets': 0,
                    'plays': 0, 'passes': 0,
                }
                games[team] = set()
            s = scheme[team]
            s['plays'] += 1
            if play_type == 'pass':
                s['passes'] += 1
            games[team].add(play.get('game_id') or '')

            if play_type == 'pass':
                rec_id = play.get('receiver_player_id') or ''
                rec_name_raw = play.get('receiver_player_name') or ''
                if rec_id or rec_name_raw:
                    rec_pos = gsis_to_pos.get(rec_id) if rec_id else None
                    if rec_pos is None and rec_name_raw:
                        rec_pos = name_to_pos.get(normalize_name(rec_name_raw))
                    s['total_targets'] += 1
                    if rec_pos == 'RB':
                        s['rb_targets'] += 1
                    elif rec_pos == 'TE':
                        s['te_targets'] += 1
                    elif rec_pos == 'WR':
                        s['wr_targets'] += 1
                    if rec_id:
                        if rec_pos:
                            id_hits += 1
                        else:
                            id_misses += 1

    for team, gs in games.items():
        scheme[team]['games'] = max(1, len(gs - {''}))

    return scheme, id_hits, id_misses


def aggregate_personnel(part_path: Path):
    """Aggregate per-team personnel features from participation."""
    personnel = {}
    with open(part_path, 'r', encoding='utf-8', errors='replace') as f:
        reader = csv.DictReader(f)
        for p in reader:
            team = p.get('possession_team') or ''
            pers = p.get('offense_personnel') or ''
            if not team or not pers:
                continue
            if team not in personnel:
                personnel[team] = {
                    'p11': 0, 'p12': 0, 'p13': 0, 'p21': 0, 'p22': 0, 'p10': 0,
                    'total': 0, 'wr3plus': 0, 'te2plus': 0,
                }
            acc = personnel[team]
            acc['total'] += 1
            rb_m = re.search(r'(\d+)\s*RB', pers)
            te_m = re.search(r'(\d+)\s*TE', pers)
            wr_m = re.search(r'(\d+)\s*WR', pers)
            rb = int(rb_m.group(1)) if rb_m else 0
            te = int(te_m.group(1)) if te_m else 0
            wr = int(wr_m.group(1)) if wr_m else 0
            code = f'{rb}{te}'
            if code in ('11', '12', '13', '21', '22', '10'):
                acc[f'p{code}'] += 1
            if wr >= 3:
                acc['wr3plus'] += 1
            if te >= 2:
                acc['te2plus'] += 1
    return personnel


def build_team_features(scheme: dict, personnel: dict):
    """Derive per-team feature values from raw aggregates."""
    out = {}
    teams = set(scheme.keys()) | set(personnel.keys())
    for team in teams:
        s = scheme.get(team, {})
        p = personnel.get(team)
        t_tgts = max(1, s.get('total_targets', 0))
        games = max(1, s.get('games', 1))
        p_total = max(1, p['total']) if p else 1
        out[team] = {
            'teamRBTargetRate': round(s.get('rb_targets', 0) / t_tgts, 3),
            'teamTETargetRate': round(s.get('te_targets', 0) / t_tgts, 3),
            'teamWRTargetRate': round(s.get('wr_targets', 0) / t_tgts, 3),
            'teamRBTargetsPerGame': round(s.get('rb_targets', 0) / games, 1),
            'teamTETargetsPerGame': round(s.get('te_targets', 0) / games, 1),
            'team11Rate': round(p['p11'] / p_total, 3) if p else 0.0,
            'team12Rate': round(p['p12'] / p_total, 3) if p else 0.0,
            'team13Rate': round(p['p13'] / p_total, 3) if p else 0.0,
            'team21Rate': round(p['p21'] / p_total, 3) if p else 0.0,
            'team22Rate': round(p['p22'] / p_total, 3) if p else 0.0,
            'team10Rate': round(p['p10'] / p_total, 3) if p else 0.0,
            'teamWR3PlusOnField': round(p['wr3plus'] / p_total, 3) if p else 0.0,
            'team2PlusTEOnField': round(p['te2plus'] / p_total, 3) if p else 0.0,
        }
    return out


TEAM_FEATURE_KEYS = PERSONNEL_KEYS + TARGET_RATE_KEYS


def compute_aggregates(seasons):
    """Fetch raw data and build per-(season,team) feature aggregates.

    Returns a dict shaped:
      {
        'generatedAt': ISO timestamp,
        'seasons': [...],
        'features': TEAM_FEATURE_KEYS,
        'perSeason': {
          '2023': {
            'TEN': {'team11Rate': ..., 'teamRBTargetRate': ..., ...},
            ...
          },
          ...
        },
        'nameToTeam': {
          '2023': {'chris johnson': 'TEN', ...},  # normalized name → team
          ...
        },
      }
    Saved as a small JSON artifact so the backfill is reproducible without
    re-downloading and so the feature store + training cache can both be
    populated from the same source of truth.
    """
    result = {
        'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%S'),
        'seasons': seasons,
        'features': TEAM_FEATURE_KEYS,
        'perSeason': {},
        'nameToTeam': {},
    }

    for season in seasons:
        print(f'\n=== Season {season} ===')
        name_to_team, name_to_pos, gsis_to_pos = build_roster_maps(season)
        print(f'  rosters: {len(name_to_team)} team assignments, {len(gsis_to_pos)} gsis→position')
        if not name_to_team:
            print(f'  no roster data; skipping')
            continue

        pbp_path = curl_cached(f'pbp/play_by_play_{season - 1}.csv', f'play_by_play_{season - 1}.csv')
        if pbp_path is None:
            print(f'  no PBP for {season - 1}; skipping')
            continue
        scheme, id_hits, id_misses = aggregate_scheme(pbp_path, gsis_to_pos, name_to_pos)
        id_rate = id_hits / max(1, id_hits + id_misses) * 100
        print(f'  scheme: {len(scheme)} teams; gsis hit rate {id_rate:.0f}% ({id_hits}/{id_hits+id_misses})')

        part_path = curl_cached(
            f'pbp_participation/pbp_participation_{season - 1}.csv',
            f'pbp_participation_{season - 1}.csv',
        )
        if part_path is not None:
            personnel = aggregate_personnel(part_path)
            print(f'  personnel: {len(personnel)} teams with participation data')
        else:
            personnel = {}
            print('  no participation data (pre-2016 seasons lack this file)')

        team_features = build_team_features(scheme, personnel)
        result['perSeason'][str(season)] = team_features
        result['nameToTeam'][str(season)] = name_to_team

    return result


def apply_aggregates_to_training_cache(aggregates: dict):
    """Update training-rows-cache-v43.json with per-team feature values."""
    print(f'\nLoading training cache from {CACHE_PATH}...')
    with open(CACHE_PATH) as f:
        data = json.load(f)
    rows = data['rows']
    print(f'  {len(rows)} rows loaded')

    total_updated = 0
    total_missed = 0

    rows_by_season = {}
    for r in rows:
        rows_by_season.setdefault(r['season'], []).append(r)

    for season_str, team_features in aggregates['perSeason'].items():
        season = int(season_str)
        name_to_team = aggregates['nameToTeam'].get(season_str, {})
        season_rows = rows_by_season.get(season, [])
        updated = 0
        missed = 0
        for row in season_rows:
            name = normalize_name(row.get('name'))
            team = name_to_team.get(name)
            if not team:
                missed += 1
                continue
            feat_vals = team_features.get(team)
            if not feat_vals:
                missed += 1
                continue
            row.setdefault('features', {}).update(feat_vals)
            updated += 1
        print(f'  {season}: {updated} updated, {missed} missed')
        total_updated += updated
        total_missed += missed

    print(f'\nTraining cache: {total_updated} updated, {total_missed} missed')

    tmp = CACHE_PATH.with_suffix('.json.tmp')
    print(f'Writing {CACHE_PATH}...')
    with open(tmp, 'w') as f:
        json.dump(data, f)
    tmp.replace(CACHE_PATH)
    print(f'  {CACHE_PATH.stat().st_size / 1024 / 1024:.1f} MB')


def apply_aggregates_to_feature_store(aggregates: dict):
    """Update the feature store coaching shard with per-team feature values.

    The coaching shard is keyed by "normalized_name::season" and contains
    each player's coaching-group feature values. We join on name via the
    aggregates' nameToTeam map, which comes from the same rosters snapshot
    used to build the per-team aggregates.
    """
    if not FEATURE_STORE_COACHING.exists():
        print(f'\n(feature store shard missing at {FEATURE_STORE_COACHING}, skipping)')
        return

    print(f'\nLoading feature store coaching shard from {FEATURE_STORE_COACHING}...')
    with open(FEATURE_STORE_COACHING) as f:
        shard = json.load(f)
    print(f'  {len(shard)} player-season entries loaded')

    total_updated = 0
    total_missed = 0
    by_season_updated = {}

    for key, features in shard.items():
        if not isinstance(features, dict) or '::' not in key:
            continue
        name, season_str = key.rsplit('::', 1)
        try:
            season = int(season_str)
        except ValueError:
            continue

        team_features = aggregates['perSeason'].get(str(season))
        if not team_features:
            total_missed += 1
            continue
        name_to_team = aggregates['nameToTeam'].get(str(season), {})
        team = name_to_team.get(name)
        if not team:
            total_missed += 1
            continue
        feat_vals = team_features.get(team)
        if not feat_vals:
            total_missed += 1
            continue
        features.update(feat_vals)
        total_updated += 1
        by_season_updated[season] = by_season_updated.get(season, 0) + 1

    print(f'  Feature store: {total_updated} updated, {total_missed} missed')

    tmp = FEATURE_STORE_COACHING.with_suffix('.json.tmp')
    with open(tmp, 'w') as f:
        json.dump(shard, f)
    tmp.replace(FEATURE_STORE_COACHING)
    size_mb = FEATURE_STORE_COACHING.stat().st_size / 1024 / 1024
    print(f'  Wrote {size_mb:.1f} MB')


def main():
    args = sys.argv[1:]
    seasons = DEFAULT_SEASONS
    from_cache = '--from-cache' in args
    if '--seasons' in args:
        idx = args.index('--seasons')
        if idx + 1 < len(args):
            seasons = [int(s) for s in args[idx + 1].split(',')]

    if from_cache and AGGREGATES_PATH.exists():
        print(f'Loading pre-computed aggregates from {AGGREGATES_PATH}...')
        with open(AGGREGATES_PATH) as f:
            aggregates = json.load(f)
        print(f'  generated at {aggregates.get("generatedAt")}')
        print(f'  covering seasons {aggregates.get("seasons")}')
    else:
        aggregates = compute_aggregates(seasons)
        print(f'\nSaving aggregates artifact to {AGGREGATES_PATH}...')
        AGGREGATES_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(AGGREGATES_PATH, 'w') as f:
            json.dump(aggregates, f, indent=None, separators=(',', ':'))
        size_kb = AGGREGATES_PATH.stat().st_size / 1024
        print(f'  Wrote {size_kb:.0f} KB')

    apply_aggregates_to_training_cache(aggregates)
    apply_aggregates_to_feature_store(aggregates)


if __name__ == '__main__':
    main()
