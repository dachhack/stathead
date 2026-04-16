#!/usr/bin/env python3
"""Fetch college football data from CollegeFootballData.com and normalize
into the tall format buildFeatureMatrix expects.

Pulls three endpoints per year (2011-2025):
  /stats/player/season       — per-player season stats (passing, rushing, receiving, games)
  /ratings/sp                — SP+ team ratings (quality + SoS)
  /recruiting/players        — 247 composite recruit rankings

Output:
  public/data/cfbd/<endpoint>-<year>.json     — raw per-year cache (gitignored)
  public/data/cfbd-college-stats.json         — normalized tall format (committed)

Tall format matches JackLich10/nfl-draft-data/college_statistics.csv:
  { player_name, pos_abbr, school, season, statistic, value }

Also emits two sidecar rollups (committed) that don't fit the tall shape:
  public/data/cfbd-sp-ratings.json            — { school → season → rating }
  public/data/cfbd-recruiting.json            — { player_name → { stars, rank, class_year, ... } }

Call budget: 45 calls for a full 2011-2025 first pull. Script is idempotent —
reruns skip years already in the raw cache unless --force is passed.

Usage:
  python3 scripts/fetch_cfbd_college_stats.py                 # fetch missing years
  python3 scripts/fetch_cfbd_college_stats.py --force         # re-fetch everything
  python3 scripts/fetch_cfbd_college_stats.py --years 2024,2025
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv('.env.local')
except ImportError:
    pass  # running in CI where env is set directly

import cfbd

API_KEY = os.environ.get('CFBD_API_KEY')
if not API_KEY:
    print('ERROR: CFBD_API_KEY not set (check .env.local or GitHub secret)', file=sys.stderr)
    sys.exit(1)

DEFAULT_YEARS = list(range(2011, 2026))  # 2011-2025 inclusive
RAW_DIR = Path('public/data/cfbd')
RAW_DIR.mkdir(parents=True, exist_ok=True)
NORMALIZED_PATH = Path('public/data/cfbd-college-stats.json')
SP_PATH = Path('public/data/cfbd-sp-ratings.json')
RECRUIT_PATH = Path('public/data/cfbd-recruiting.json')

cfg = cfbd.Configuration()
cfg.api_key['Authorization'] = API_KEY
cfg.api_key_prefix['Authorization'] = 'Bearer'
client = cfbd.ApiClient(cfg)
stats_api = cfbd.StatsApi(client)
ratings_api = cfbd.RatingsApi(client)
recruiting_api = cfbd.RecruitingApi(client)


def to_dict(obj) -> dict:
    """Serialize a cfbd pydantic v1 model to a plain dict of field values.

    The previous dir()-walk silently dropped fields that pydantic stored in
    private machinery. .dict() uses the declared schema directly.
    """
    if hasattr(obj, 'dict') and callable(getattr(obj, 'dict')):
        try:
            return obj.dict()
        except Exception:
            pass
    if hasattr(obj, 'to_dict') and callable(getattr(obj, 'to_dict')):
        try:
            return obj.to_dict()
        except Exception:
            pass
    # Fallback for plain objects
    out = {}
    for a in dir(obj):
        if a.startswith('_') or callable(getattr(obj, a, None)):
            continue
        v = getattr(obj, a, None)
        if v is None or isinstance(v, (int, float, str, bool, list, dict)):
            out[a] = v
        else:
            out[a] = str(v)
    return out


def fetch_year(year: int, force: bool = False) -> dict:
    """Fetch the three endpoints for one year. Returns raw-serialized payloads.

    Exceptions propagate — an upstream outage should fail the workflow loudly
    rather than silently committing empty rollups.
    """
    year_data = {}
    endpoints = [
        ('player-season', lambda: stats_api.get_player_season_stats(year=year)),
        ('sp-ratings',    lambda: ratings_api.get_sp(year=year)),
        ('recruiting',    lambda: recruiting_api.get_recruits(year=year)),
    ]
    for name, fn in endpoints:
        path = RAW_DIR / f'{name}-{year}.json'
        if path.exists() and not force:
            year_data[name] = json.loads(path.read_text())
            print(f'  {year} {name}: cached ({len(year_data[name])} rows)')
            continue
        t0 = time.time()
        rows = fn()
        dicts = [to_dict(r) for r in rows]
        path.write_text(json.dumps(dicts, default=str))
        year_data[name] = dicts
        elapsed = round(time.time() - t0, 1)
        sample = json.dumps(dicts[0], default=str)[:240] if dicts else '(empty)'
        print(f'  {year} {name}: {len(dicts)} rows ({elapsed}s)  sample={sample}')
    return year_data


def normalize_player_stats(raw_by_year: dict) -> list[dict]:
    """Flatten /stats/player/season into the tall {name, pos, school, season, stat, value} shape.

    CFBD returns one row per (player, category, stat_type) triple. We keep the
    ones we care about (passing/rushing/receiving/games) and rename to match
    the existing college_statistics.csv vocabulary so the downstream builder
    treats them identically.
    """
    # CFBD stat_type → college_statistics.csv "statistic" vocabulary
    STAT_MAP = {
        'YDS': {'passing': 'Passing Yards', 'rushing': 'Rushing Yards', 'receiving': 'Receiving Yards'},
        'TD':  {'passing': 'Passing Touchdowns', 'rushing': 'Rushing Touchdowns', 'receiving': 'Receiving Touchdowns'},
        'ATT': {'passing': 'Passing Attempts', 'rushing': 'Rushing Attempts'},
        'COMPLETIONS': {'passing': 'Completions'},
        'REC': {'receiving': 'Receptions'},
        'INT': {'passing': 'Interceptions'},
        'GAMES': {None: 'Games Played'},  # CFBD reports games under category='unknown' or similar
    }
    out = []
    for year, payload in raw_by_year.items():
        for r in payload.get('player-season', []):
            name = r.get('player') or r.get('player_name') or ''
            school = (r.get('team') or '').lower()
            pos = (r.get('position') or '').upper()
            cat = (r.get('category') or '').lower()
            stat_type = (r.get('stat_type') or '').upper()
            val = r.get('stat')
            if val is None:
                continue
            try:
                val = float(val)
            except (TypeError, ValueError):
                continue
            mapped = STAT_MAP.get(stat_type, {}).get(cat)
            if mapped is None:
                mapped = STAT_MAP.get(stat_type, {}).get(None)
            if mapped is None:
                continue
            out.append({
                'player_name': name,
                'pos_abbr': pos,
                'school': school,
                'season': int(year),
                'statistic': mapped,
                'value': val,
            })
    return out


def normalize_sp(raw_by_year: dict) -> dict:
    """Roll SP+ ratings into { 'school:season': { rating, offense, defense, sos } }."""
    out = {}
    for year, payload in raw_by_year.items():
        for r in payload.get('sp-ratings', []):
            team = (r.get('team') or '').lower()
            if not team:
                continue
            key = f'{team}:{year}'
            out[key] = {
                'rating': r.get('rating'),
                'offense_rating': (r.get('offense') or {}).get('rating') if isinstance(r.get('offense'), dict) else None,
                'defense_rating': (r.get('defense') or {}).get('rating') if isinstance(r.get('defense'), dict) else None,
                'sos': r.get('sos'),
                'second_order_wins': r.get('second_order_wins'),
            }
    return out


def normalize_recruiting(raw_by_year: dict) -> dict:
    """Roll recruits into { normalized_name → { stars, rank, class_year, school, ... } }.

    Keep the highest-star / earliest-year record per name when duplicates exist
    (rare but happens with JUCO transfers).
    """
    import re
    def norm(n: str) -> str:
        return re.sub(r'[^a-z0-9]+', '', (n or '').lower())
    out = {}
    for year, payload in raw_by_year.items():
        for r in payload.get('recruiting', []):
            name = r.get('name') or ''
            k = norm(name)
            if not k:
                continue
            entry = {
                'stars': r.get('stars'),
                'rank': r.get('ranking'),
                'class_year': int(year),
                'position': r.get('position'),
                'committed_to': r.get('committed_to'),
                'composite_rating': r.get('rating'),
                'height': r.get('height'),
                'weight': r.get('weight'),
            }
            existing = out.get(k)
            if existing is None or (entry.get('stars') or 0) > (existing.get('stars') or 0):
                out[k] = entry
    return out


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--force', action='store_true', help='Re-fetch even if cached')
    p.add_argument('--years', help='Comma-separated years (default: 2011-2025)')
    args = p.parse_args()

    years = [int(y) for y in args.years.split(',')] if args.years else DEFAULT_YEARS
    print(f'Fetching {len(years)} years: {min(years)}-{max(years)}')

    raw_by_year = {}
    for year in years:
        raw_by_year[year] = fetch_year(year, force=args.force)

    print('\nNormalizing...')
    tall = normalize_player_stats(raw_by_year)
    sp = normalize_sp(raw_by_year)
    recruits = normalize_recruiting(raw_by_year)
    print(f'  Player stats (tall): {len(tall)} rows')
    print(f'  SP+ ratings: {len(sp)} team-seasons')
    print(f'  Recruits: {len(recruits)} players')

    NORMALIZED_PATH.write_text(json.dumps(tall))
    SP_PATH.write_text(json.dumps(sp))
    RECRUIT_PATH.write_text(json.dumps(recruits))
    print(f'\nWrote:')
    print(f'  {NORMALIZED_PATH} ({NORMALIZED_PATH.stat().st_size // 1024} KB)')
    print(f'  {SP_PATH}          ({SP_PATH.stat().st_size // 1024} KB)')
    print(f'  {RECRUIT_PATH}     ({RECRUIT_PATH.stat().st_size // 1024} KB)')


if __name__ == '__main__':
    main()
