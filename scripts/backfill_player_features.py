#!/usr/bin/env python3
"""
Backfill per-player PBP-derived features + preseason injury flags.

Complements scripts/backfill_team_features.py (which handles team-level
features) by populating the *per-player* features that had 0% coverage
because of silent join failures:

  Advanced receiving (from PBP):
    priorADOT              — average depth of target per player-season
    priorDeepTargetPct     — air_yards ≥ 20 rate per player-season
    priorRZTargetShare     — player's red zone targets / team's RZ targets
  Preseason injury (from injuries CSV):
    preseasonInjured       — 1 if carrying injury designation into weeks 1-2
    preseasonInjWeeks      — count of early-season reports

## Bug 1: PBP join key mismatch (same as team-features PR #119)

advanced.ts and buildFeatureMatrix.ts built `pbpByReceiver` keyed on
normalizeName(play.receiver_player_name). PBP abbreviates to "Mi.Carter"
while rosters use full names. Every lookup failed → always zero.

Fix: aggregate by gsis_id (play.receiver_player_id), then resolve to
normalized full name via a rosters-derived gsis → normalized_name map.

## Bug 2: Preseason injuries filter was too restrictive

injuries_{S}.csv has only game_type=REG rows starting at week=1. The
filter `game_type==='PRE' || week<=0` matched nothing. There is no
actual preseason data in this source.

Pragmatic fix: use weeks 1-2 of the current season as a "was this player
entering the regular season with injury designations?" proxy. Players
on the injury report at Week 1 games are essentially reflecting
preseason-end health status.

## Usage

    python3 scripts/backfill_player_features.py              # full: fetch + aggregate + apply
    python3 scripts/backfill_player_features.py --from-cache # reuse committed artifact
    python3 scripts/backfill_player_features.py --seasons 2018,2019,2020
"""

import csv
import io
import json
import re
import subprocess
import sys
import time
from pathlib import Path

CACHE_PATH = Path('public/data/training-rows-cache-v42.json')
FEATURE_STORE_ADVANCED = Path('public/data/feature-store/advanced.json')
FEATURE_STORE_INJURIES = Path('public/data/feature-store/injuries.json')
AGGREGATES_PATH = Path('public/data/player-features-backfill.json')
DL_CACHE = Path('.nflverse-cache')
NFLVERSE = 'https://github.com/nflverse/nflverse-data/releases/download'
DEFAULT_SEASONS = list(range(2010, 2026))
SKILL_POSITIONS = {'QB', 'RB', 'WR', 'TE'}

ADVANCED_KEYS = ['priorADOT', 'priorDeepTargetPct', 'priorRZTargetShare']
INJURY_KEYS = ['preseasonInjured', 'preseasonInjWeeks']
ALL_FEATURE_KEYS = ADVANCED_KEYS + INJURY_KEYS


def normalize_name(s):
    if not s:
        return ''
    s = s.lower().replace('.', '').replace("'", '').strip()
    for suffix in (' jr', ' sr', ' iii', ' iv', ' ii'):
        if s.endswith(suffix):
            s = s[: -len(suffix)].strip()
            break
    return s


def curl_cached(subpath: str, dest_name: str) -> Path | None:
    """Download via curl (Node fetch times out on nflverse URLs)."""
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
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        return list(csv.DictReader(f))


def build_gsis_name_map(season: int):
    """Return gsis_id → normalized_name (from current + prior rosters).

    Used to resolve PBP's receiver_player_id (gsis_id) to the same normalized
    full name that player rows use as their key. Without this, the PBP
    aggregation can't be joined onto the training cache.
    """
    gsis_to_name = {}
    for offset in (0, -1):
        dest = curl_cached(f'rosters/roster_{season + offset}.csv',
                           f'roster_{season + offset}.csv')
        if dest is None:
            continue
        try:
            rosters = read_csv_dict(dest)
        except Exception as e:
            print(f'  failed to read {dest.name}: {e}')
            continue
        for r in rosters:
            gsis = r.get('gsis_id') or ''
            if not gsis:
                continue
            name = normalize_name(r.get('full_name') or r.get('player_name'))
            if not name:
                continue
            # Precedence: current season wins (first loop iteration)
            if gsis not in gsis_to_name:
                gsis_to_name[gsis] = name
    return gsis_to_name


def aggregate_player_pbp(pbp_path: Path, gsis_to_name: dict):
    """Per-player air yards, targets, deep targets, RZ targets from PBP.

    Also computes per-team RZ target totals (the denominator for
    priorRZTargetShare).
    """
    # name → {targets, airYards, deepTargets, rzTargets}
    player_agg = {}
    # team → total RZ targets (denominator)
    team_rz_totals = {}

    with open(pbp_path, 'r', encoding='utf-8', errors='replace') as f:
        reader = csv.DictReader(f)
        for play in reader:
            if play.get('play_type') != 'pass':
                continue
            rec_id = play.get('receiver_player_id') or ''
            if not rec_id:
                continue
            name = gsis_to_name.get(rec_id)
            if not name:
                continue

            try:
                air_yards = float(play.get('air_yards') or 0)
            except ValueError:
                air_yards = 0.0
            try:
                yardline = float(play.get('yardline_100') or 100)
            except ValueError:
                yardline = 100.0

            acc = player_agg.get(name)
            if acc is None:
                acc = {'targets': 0, 'airYards': 0.0, 'deepTargets': 0, 'rzTargets': 0}
                player_agg[name] = acc
            acc['targets'] += 1
            acc['airYards'] += air_yards
            if air_yards >= 15:
                acc['deepTargets'] += 1
            if yardline <= 20:
                acc['rzTargets'] += 1
                team = play.get('posteam') or ''
                if team:
                    team_rz_totals[team] = team_rz_totals.get(team, 0) + 1

    return player_agg, team_rz_totals


def build_name_to_team(season: int):
    """Build normalized_name → team for the specified season, for per-player
    feature joins. Uses current-season roster first."""
    name_to_team = {}
    for offset in (0, -1):
        dest = curl_cached(f'rosters/roster_{season + offset}.csv',
                           f'roster_{season + offset}.csv')
        if dest is None:
            continue
        try:
            rosters = read_csv_dict(dest)
        except Exception:
            continue
        for r in rosters:
            name = normalize_name(r.get('full_name') or r.get('player_name'))
            team = r.get('team') or ''
            if name and team and name not in name_to_team:
                name_to_team[name] = team
    return name_to_team


def build_player_advanced_features(player_agg: dict, team_rz_totals: dict, name_to_team: dict):
    """Derive priorADOT, priorDeepTargetPct, priorRZTargetShare per player."""
    out = {}
    for name, acc in player_agg.items():
        tgts = acc['targets']
        if tgts == 0:
            continue
        adot = acc['airYards'] / tgts
        deep_pct = acc['deepTargets'] / tgts
        # RZ target share uses the player's TEAM in the PRIOR season
        # (team_rz_totals is keyed by posteam from that PBP season).
        # name_to_team comes from the CURRENT season roster, which is
        # usually their team from the prior year too. Close enough.
        team = name_to_team.get(name, '')
        team_rz = team_rz_totals.get(team, 0)
        rz_share = (acc['rzTargets'] / team_rz) if team_rz > 0 else 0
        out[name] = {
            'priorADOT': round(adot, 1),
            'priorDeepTargetPct': round(deep_pct, 3),
            'priorRZTargetShare': round(rz_share, 3),
        }
    return out


def aggregate_preseason_injuries(inj_path: Path):
    """Aggregate per-player injury designations for weeks 1-2 of the season.

    There's no true preseason data in the nflverse injuries CSV — but weeks
    1-2 reports reflect players carrying injury designations INTO the
    regular season, which is the closest proxy for "entered the year
    banged up".
    """
    agg = {}  # name → {injured, weeks}
    with open(inj_path, 'r', encoding='utf-8', errors='replace') as f:
        reader = csv.DictReader(f)
        for inj in reader:
            try:
                week = int(inj.get('week') or 0)
            except ValueError:
                continue
            if week < 1 or week > 2:
                continue
            name = normalize_name(inj.get('full_name'))
            if not name:
                continue
            if name not in agg:
                agg[name] = {'injured': 0, 'weeks': 0}
            status = (inj.get('report_status') or '').strip()
            if status in ('Out', 'Doubtful', 'Questionable'):
                agg[name]['injured'] = 1
                agg[name]['weeks'] += 1
    return agg


def compute_aggregates(seasons):
    """Fetch raw data and build per-player feature aggregates per season."""
    result = {
        'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%S'),
        'seasons': seasons,
        'features': ALL_FEATURE_KEYS,
        'perSeason': {},
    }

    for season in seasons:
        print(f'\n=== Season {season} ===')
        per_season = {}

        # ── Advanced per-player PBP features (uses prior season PBP) ──
        gsis_to_name = build_gsis_name_map(season)
        if not gsis_to_name:
            print(f'  no rosters; skipping advanced for {season}')
        else:
            pbp_path = curl_cached(f'pbp/play_by_play_{season - 1}.csv',
                                   f'play_by_play_{season - 1}.csv')
            if pbp_path is None:
                print(f'  no PBP for {season - 1}; skipping advanced')
            else:
                player_agg, team_rz = aggregate_player_pbp(pbp_path, gsis_to_name)
                name_to_team = build_name_to_team(season - 1)  # prior year team for RZ denom
                advanced = build_player_advanced_features(player_agg, team_rz, name_to_team)
                print(f'  advanced: {len(advanced)} players with priorADOT/DeepPct/RZShare')
                per_season['advanced'] = advanced

        # ── Preseason injury features (uses CURRENT season weeks 1-2) ──
        inj_path = curl_cached(f'injuries/injuries_{season}.csv',
                               f'injuries_{season}.csv')
        if inj_path is None:
            print(f'  no injuries for {season}; skipping preseason injury')
        else:
            inj_agg = aggregate_preseason_injuries(inj_path)
            print(f'  preseason injuries: {len(inj_agg)} players with wk1-2 designations')
            per_season['preseasonInjuries'] = {
                name: {'preseasonInjured': v['injured'], 'preseasonInjWeeks': v['weeks']}
                for name, v in inj_agg.items()
            }

        if per_season:
            result['perSeason'][str(season)] = per_season

    return result


def apply_aggregates_to_training_cache(aggregates: dict):
    print(f'\nLoading training cache from {CACHE_PATH}...')
    with open(CACHE_PATH) as f:
        data = json.load(f)
    rows = data['rows']
    print(f'  {len(rows)} rows loaded')

    adv_updated = 0
    inj_updated = 0
    missed = 0

    rows_by_season = {}
    for r in rows:
        rows_by_season.setdefault(r['season'], []).append(r)

    for season_str, per_season in aggregates['perSeason'].items():
        season = int(season_str)
        adv = per_season.get('advanced', {})
        inj = per_season.get('preseasonInjuries', {})
        for row in rows_by_season.get(season, []):
            name = normalize_name(row.get('name'))
            f = row.setdefault('features', {})
            got = False
            if name in adv:
                f.update(adv[name])
                adv_updated += 1
                got = True
            if name in inj:
                f.update(inj[name])
                inj_updated += 1
                got = True
            if not got:
                missed += 1

    print(f'  Training cache: {adv_updated} advanced updates, {inj_updated} injury updates, {missed} fully missed')

    tmp = CACHE_PATH.with_suffix('.json.tmp')
    with open(tmp, 'w') as f:
        json.dump(data, f)
    tmp.replace(CACHE_PATH)
    print(f'  {CACHE_PATH.stat().st_size / 1024 / 1024:.1f} MB')


def apply_aggregates_to_feature_store(aggregates: dict):
    """Update advanced + injuries shards."""
    for shard_path, feat_type, keys in [
        (FEATURE_STORE_ADVANCED, 'advanced', ADVANCED_KEYS),
        (FEATURE_STORE_INJURIES, 'preseasonInjuries', INJURY_KEYS),
    ]:
        if not shard_path.exists():
            print(f'\n(feature store shard missing at {shard_path}, skipping)')
            continue
        print(f'\nLoading {shard_path.name}...')
        with open(shard_path) as f:
            shard = json.load(f)
        print(f'  {len(shard)} player-season entries loaded')

        updated = 0
        missed = 0
        for key, features in shard.items():
            if not isinstance(features, dict) or '::' not in key:
                continue
            name, season_str = key.rsplit('::', 1)
            per_season = aggregates['perSeason'].get(season_str)
            if not per_season:
                missed += 1
                continue
            player_data = per_season.get(feat_type, {})
            if name not in player_data:
                missed += 1
                continue
            features.update(player_data[name])
            updated += 1

        print(f'  {shard_path.name}: {updated} updated, {missed} missed')
        tmp = shard_path.with_suffix('.json.tmp')
        with open(tmp, 'w') as f:
            json.dump(shard, f)
        tmp.replace(shard_path)
        print(f'  {shard_path.stat().st_size / 1024 / 1024:.1f} MB')


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
