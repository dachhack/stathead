#!/usr/bin/env python3
"""
Backfill per-player PBP-derived features + prior late-season injury history.

Complements scripts/backfill_team_features.py (team-level features) by
populating per-PLAYER features that had 0% coverage:

  Advanced receiving (from season S-1 PBP):
    priorADOT              — average depth of target per player-season
    priorDeepTargetPct     — air_yards ≥ 20 rate per player-season
    priorRZTargetShare     — player's RZ targets / team's RZ targets
  Late-prior-season injury (from season S-1 injuries):
    priorLateSeasonInjured — 1 if carried Out/Doubtful/Questionable
                              designation in weeks 15-18 of S-1
    priorLateSeasonInjWeeks — count of such reports in weeks 15-18 of S-1

IMPORTANT — NO LEAKAGE: both signals use season S-1 data only. A row
for player X in season S must never use information from season S,
including Week 1 reports of that season. An earlier version of this
script accidentally used weeks 1-2 of CURRENT season S as a "preseason
injury" proxy — that was outcome leakage and gave +0.003 fake R² for
TE. Reverted.

## Bug 1: PBP join key mismatch (same as team-features PR #119)

advanced.ts and buildFeatureMatrix.ts built `pbpByReceiver` keyed on
normalizeName(play.receiver_player_name). PBP abbreviates to "Mi.Carter"
while rosters use full names. Every lookup failed → always zero.
Fix: resolve via gsis_id (play.receiver_player_id) through rosters'
gsis → full_name map.

## Bug 2: "Preseason" injuries concept is unsupportable

The nflverse injuries CSV has only game_type=REG rows starting at
week=1. No PRE, no week 0, no actual preseason. The old TS code
filtered `game_type==='PRE' || week<=0` which matched nothing. That
was at least honest (features stayed 0%); replacing it with week 1-2
of current season was worse (leakage).

Honest replacement: priorLateSeasonInjWeeks from weeks 15-18 of the
PRIOR season. Captures "ended last year hurt, likely entering this
year still dealing with it" without touching the target season.

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

CACHE_PATH = Path('public/data/training-rows-cache-v46.json')
FEATURE_STORE_ADVANCED = Path('public/data/feature-store/advanced.json')
FEATURE_STORE_INJURIES = Path('public/data/feature-store/injuries.json')
AGGREGATES_PATH = Path('public/data/player-features-backfill.json')
DL_CACHE = Path('.nflverse-cache')
NFLVERSE = 'https://github.com/nflverse/nflverse-data/releases/download'
DEFAULT_SEASONS = list(range(2010, 2026))
SKILL_POSITIONS = {'QB', 'RB', 'WR', 'TE'}

ADVANCED_KEYS = ['priorADOT', 'priorDeepTargetPct', 'priorRZTargetShare']
# New (non-leaky) injury keys — computed from prior season's late-season
# weeks (15-18), not current season. The old preseasonInjured /
# preseasonInjWeeks keys are DEAD — see the module docstring.
INJURY_KEYS = ['priorLateSeasonInjured', 'priorLateSeasonInjWeeks']
ALL_FEATURE_KEYS = ADVANCED_KEYS + INJURY_KEYS

# Feature keys to STRIP from existing rows/shards when running this backfill.
# Removes the leaky preseasonInjured/preseasonInjWeeks values shipped in #120
# so they don't linger as dead fields. Listed here so future consumers that
# want to do a cleanup-only pass can just reference this set.
DEAD_KEYS_TO_STRIP = ['preseasonInjured', 'preseasonInjWeeks']


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


def aggregate_late_season_injuries(inj_path: Path):
    """Per-player injury designations from the LATE prior season (weeks 15-18).

    Used as a proxy for "ended the prior season hurt, still dealing with
    lingering issues entering the new season". Only touches season S-1
    data so there is no lookahead leakage.

    Counts weeks 15-18 reports with Out/Doubtful/Questionable status,
    which captures stretch-run injuries that tend to persist into the
    offseason / new season kickoff.
    """
    agg = {}  # name → {injured, weeks}
    with open(inj_path, 'r', encoding='utf-8', errors='replace') as f:
        reader = csv.DictReader(f)
        for inj in reader:
            try:
                week = int(inj.get('week') or 0)
            except ValueError:
                continue
            if week < 15 or week > 18:
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

        # ── Late-prior-season injury features (uses season S-1 weeks 15-18) ──
        # NO LEAKAGE: we read only from season S-1's injury file, since the
        # row at (name, season S) is predicting season S outcomes.
        inj_path = curl_cached(f'injuries/injuries_{season - 1}.csv',
                               f'injuries_{season - 1}.csv')
        if inj_path is None:
            print(f'  no injuries for {season - 1}; skipping late-season injury')
        else:
            inj_agg = aggregate_late_season_injuries(inj_path)
            print(f'  late-season injuries: {len(inj_agg)} players w/ wk15-18 designations in S-1')
            per_season['lateSeasonInjuries'] = {
                name: {
                    'priorLateSeasonInjured': v['injured'],
                    'priorLateSeasonInjWeeks': v['weeks'],
                }
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

    # Strip dead keys (leaky preseasonInjured/Weeks from #120)
    stripped = 0
    for r in rows:
        feats = r.get('features')
        if not isinstance(feats, dict):
            continue
        for k in DEAD_KEYS_TO_STRIP:
            if k in feats:
                del feats[k]
                stripped += 1
    if stripped:
        print(f'  Stripped {stripped} dead-key entries from training cache')

    adv_updated = 0
    inj_updated = 0
    missed = 0

    rows_by_season = {}
    for r in rows:
        rows_by_season.setdefault(r['season'], []).append(r)

    for season_str, per_season in aggregates['perSeason'].items():
        season = int(season_str)
        adv = per_season.get('advanced', {})
        inj = per_season.get('lateSeasonInjuries', {})
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
        (FEATURE_STORE_INJURIES, 'lateSeasonInjuries', INJURY_KEYS),
    ]:
        if not shard_path.exists():
            print(f'\n(feature store shard missing at {shard_path}, skipping)')
            continue
        print(f'\nLoading {shard_path.name}...')
        with open(shard_path) as f:
            shard = json.load(f)
        print(f'  {len(shard)} player-season entries loaded')

        # Strip dead keys from the injuries shard (was populated with leaky
        # preseasonInjured/Weeks values in #120 before the revert)
        if shard_path == FEATURE_STORE_INJURIES:
            stripped = 0
            for features in shard.values():
                if not isinstance(features, dict):
                    continue
                for k in DEAD_KEYS_TO_STRIP:
                    if k in features:
                        del features[k]
                        stripped += 1
            if stripped:
                print(f'  Stripped {stripped} dead-key entries')

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
