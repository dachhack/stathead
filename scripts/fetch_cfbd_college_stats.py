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

DEFAULT_YEARS = list(range(2005, 2026))  # 2005-2025 inclusive
# Extended back to 2005 to capture multi-year college histories for older
# rookies (2010+ NFL training set includes players whose college careers
# stretched back to ~2005). Older years still well within CFBD's coverage
# window and the call budget.
RAW_DIR = Path('public/data/cfbd')
RAW_DIR.mkdir(parents=True, exist_ok=True)
NORMALIZED_PATH = Path('public/data/cfbd-college-stats.json')
SP_PATH = Path('public/data/cfbd-sp-ratings.json')
RECRUIT_PATH = Path('public/data/cfbd-recruiting.json')
GAMES_PATH = Path('public/data/cfbd-games.json')
TALENT_PATH = Path('public/data/cfbd-team-talent.json')
USAGE_PATH = Path('public/data/cfbd-player-usage.json')

cfg = cfbd.Configuration(access_token=API_KEY)
client = cfbd.ApiClient(cfg)
stats_api = cfbd.StatsApi(client)
ratings_api = cfbd.RatingsApi(client)
recruiting_api = cfbd.RecruitingApi(client)
games_api = cfbd.GamesApi(client)
teams_api = cfbd.TeamsApi(client)
players_api = cfbd.PlayersApi(client)


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
    """Fetch all six endpoints for one year. Returns raw-serialized payloads.

    Exceptions propagate — an upstream outage should fail the workflow loudly
    rather than silently committing empty rollups.
    """
    year_data = {}
    endpoints = [
        ('player-season', lambda: stats_api.get_player_season_stats(year=year)),
        ('sp-ratings',    lambda: ratings_api.get_sp(year=year)),
        ('recruiting',    lambda: recruiting_api.get_recruits(year=year)),
        ('games',         lambda: games_api.get_games(year=year)),
        ('team-talent',   lambda: teams_api.get_talent(year=year)),
        ('player-usage',  lambda: players_api.get_player_usage(year=year)),
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


def normalize_games(raw_by_year: dict) -> dict:
    """Roll games into { 'school:season': games_count } counted across both
    home and away appearances. Replaces the 12-game default proxy in
    buildFeatureMatrix with exact per-team season totals.
    """
    counts: dict[str, int] = {}
    for year, payload in raw_by_year.items():
        for g in payload.get('games', []):
            for side in ('home_team', 'away_team'):
                team = (g.get(side) or '').lower()
                if not team:
                    continue
                key = f'{team}:{year}'
                counts[key] = counts.get(key, 0) + 1
    return counts


def normalize_team_talent(raw_by_year: dict) -> dict:
    """Roll team-talent into { 'school:season': talent_value }."""
    out = {}
    for year, payload in raw_by_year.items():
        for r in payload.get('team-talent', []):
            team = (r.get('team') or '').lower()
            t = r.get('talent')
            if not team or t is None:
                continue
            try:
                out[f'{team}:{year}'] = float(t)
            except (TypeError, ValueError):
                continue
    return out


def normalize_player_usage(raw_by_year: dict) -> dict:
    """Roll player-usage into { 'normalized_name:season': { overall, rush,
    pass, first_down, ... } }. Keyed by name+season because a player can
    transfer schools and their usage varies year to year.
    """
    import re
    def norm(n: str) -> str:
        return re.sub(r'[^a-z0-9]+', '', (n or '').lower())
    out = {}
    for year, payload in raw_by_year.items():
        for r in payload.get('player-usage', []):
            name = r.get('name') or ''
            k = norm(name)
            if not k:
                continue
            usage = r.get('usage') or {}
            if not isinstance(usage, dict):
                continue
            out[f'{k}:{year}'] = {
                'overall': usage.get('overall'),
                'pass': usage.get('var_pass'),  # field is var_pass to avoid Python keyword
                'rush': usage.get('rush'),
                'first_down': usage.get('first_down'),
                'second_down': usage.get('second_down'),
                'third_down': usage.get('third_down'),
                'standard_downs': usage.get('standard_downs'),
                'passing_downs': usage.get('passing_downs'),
                'team': (r.get('team') or '').lower(),
                'position': r.get('position'),
            }
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
    games = normalize_games(raw_by_year)
    talent = normalize_team_talent(raw_by_year)
    usage = normalize_player_usage(raw_by_year)
    print(f'  Player stats (tall): {len(tall)} rows')
    print(f'  SP+ ratings: {len(sp)} team-seasons')
    print(f'  Recruits: {len(recruits)} players')
    print(f'  Games: {len(games)} team-seasons')
    print(f'  Team talent: {len(talent)} team-seasons')
    print(f'  Player usage: {len(usage)} player-seasons')

    NORMALIZED_PATH.write_text(json.dumps(tall))
    SP_PATH.write_text(json.dumps(sp))
    RECRUIT_PATH.write_text(json.dumps(recruits))
    GAMES_PATH.write_text(json.dumps(games))
    TALENT_PATH.write_text(json.dumps(talent))
    USAGE_PATH.write_text(json.dumps(usage))
    print(f'\nWrote:')
    for path in (NORMALIZED_PATH, SP_PATH, RECRUIT_PATH, GAMES_PATH, TALENT_PATH, USAGE_PATH):
        print(f'  {path} ({path.stat().st_size // 1024} KB)')


if __name__ == '__main__':
    main()
