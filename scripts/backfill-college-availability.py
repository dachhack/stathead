#!/usr/bin/env python3
"""
Derive college injury/availability proxy features from college_statistics.csv.

Since we can't access the CFBD API directly, we derive availability signals
from the per-season stat rows we already have:
  - seasons_with_stats: how many seasons the player recorded stats
  - final_year_production_drop: did their last year stats regress vs peak?
  - seasons_active_ratio: seasons with stats / total eligible seasons
  - peak_vs_final_ratio: peak season production / final season production

These proxy durability — players who missed seasons or had off years show up
as having fewer stat seasons or production drops.

Usage:
    python3 scripts/backfill-college-availability.py
    python3 scripts/backfill-college-availability.py --dry-run
"""

import csv
import json
import math
import sys
from collections import defaultdict
from pathlib import Path

COLLEGE_STATS = Path('public/data/college_statistics.csv')
CACHE_PATH = Path('public/data/training-rows-cache-v48.json')
OUTPUT_PATH = Path('public/data/college-availability.json')
DRAFT_PATH = Path('public/data/draft_picks.csv')


def normalize_name(name: str) -> str:
    return name.lower().replace('.', '').replace("'", '').replace('-', ' ').strip()


def main():
    dry_run = '--dry-run' in sys.argv

    # Load college stats: per-season production by player
    print("Loading college statistics...")
    player_seasons: dict[str, dict[int, dict]] = defaultdict(dict)  # name -> {season: {stat: val}}

    with open(COLLEGE_STATS) as f:
        for row in csv.DictReader(f):
            name = normalize_name(row.get('player_name', ''))
            season = int(row.get('season', 0))
            stat = row.get('statistic', '')
            try:
                value = float(row.get('value', 0) or 0)
            except (ValueError, TypeError):
                value = 0
            pos = row.get('pos_abbr', '')
            if not name or not season or not stat:
                continue
            if season not in player_seasons[name]:
                player_seasons[name][season] = {'pos': pos}
            player_seasons[name][season][stat] = value

    print(f"  {len(player_seasons)} players with college stats")

    # Load draft picks for draft year / age context
    draft_info: dict[str, dict] = {}  # name -> {season, age, pick, position}
    with open(DRAFT_PATH) as f:
        for row in csv.DictReader(f):
            name = normalize_name(row.get('pfr_player_name', ''))
            if not name:
                continue
            draft_info[name] = {
                'season': int(row.get('season', 0)),
                'age': int(row.get('age', 0) or 0),
                'pick': int(row.get('pick', 300) or 300),
                'position': row.get('position', ''),
            }

    # Compute availability features per player
    results: dict[str, dict] = {}

    for name, seasons_data in player_seasons.items():
        if not seasons_data:
            continue

        sorted_seasons = sorted(seasons_data.keys())
        n_seasons = len(sorted_seasons)
        if n_seasons == 0:
            continue

        # Get production per season (position-dependent)
        pos = next(iter(seasons_data.values())).get('pos', '')
        season_production = []
        for s in sorted_seasons:
            stats = seasons_data[s]
            # Use total yards + TDs as production proxy (works for all positions)
            prod = (stats.get('Receiving Yards', 0) + stats.get('Rushing Yards', 0) +
                    stats.get('Passing Yards', 0) +
                    (stats.get('Receiving Touchdowns', 0) + stats.get('Rushing Touchdowns', 0) +
                     stats.get('Passing Touchdowns', 0)) * 50)  # weight TDs
            season_production.append(prod)

        if not season_production or max(season_production) == 0:
            continue

        peak_prod = max(season_production)
        final_prod = season_production[-1]

        # Eligible seasons: from first stat season to draft year (or last stat year)
        draft = draft_info.get(name, {})
        draft_year = draft.get('season', sorted_seasons[-1] + 1)
        first_season = sorted_seasons[0]
        eligible_seasons = max(1, draft_year - first_season)

        # Features
        seasons_active_ratio = round(n_seasons / eligible_seasons, 3) if eligible_seasons > 0 else 1.0
        peak_vs_final = round(final_prod / peak_prod, 3) if peak_prod > 0 else 0
        final_year_drop = 1 if peak_vs_final < 0.5 and n_seasons >= 2 else 0  # production cut in half

        # Production trend (slope of last 2 seasons)
        if n_seasons >= 2:
            trend = season_production[-1] - season_production[-2]
            trend_pct = round(trend / max(1, season_production[-2]), 3)
        else:
            trend_pct = 0

        results[name] = {
            'seasons_with_stats': n_seasons,
            'eligible_seasons': eligible_seasons,
            'seasons_active_ratio': seasons_active_ratio,
            'peak_production': round(peak_prod),
            'final_production': round(final_prod),
            'peak_vs_final_ratio': peak_vs_final,
            'final_year_drop': final_year_drop,
            'production_trend_pct': trend_pct,
            'position': pos,
        }

    print(f"  Computed availability features for {len(results)} players")

    # Stats
    drops = sum(1 for r in results.values() if r['final_year_drop'])
    low_ratio = sum(1 for r in results.values() if r['seasons_active_ratio'] < 0.75)
    print(f"  Final year drops (prod < 50% of peak): {drops} ({drops/len(results)*100:.1f}%)")
    print(f"  Low availability ratio (<75%): {low_ratio} ({low_ratio/len(results)*100:.1f}%)")

    # Patch training rows
    print(f"\nPatching training rows...")
    with open(CACHE_PATH) as f:
        cached = json.load(f)

    patched = 0
    for row in cached['rows']:
        yil = row['features'].get('yearsInLeague', 99) or 99
        if yil > 1:
            continue
        nn = normalize_name(row['name'])
        avail = results.get(nn)
        if not avail:
            continue

        f = row['features']
        changed = False

        if not f.get('collegeAvailabilityRatio'):
            f['collegeAvailabilityRatio'] = avail['seasons_active_ratio']
            changed = True
        if not f.get('collegeFinalYearDrop'):
            f['collegeFinalYearDrop'] = avail['final_year_drop']
            changed = True
        if not f.get('collegePeakVsFinal'):
            f['collegePeakVsFinal'] = avail['peak_vs_final_ratio']
            changed = True
        if not f.get('collegeProductionTrend'):
            f['collegeProductionTrend'] = avail['production_trend_pct']
            changed = True
        if not f.get('collegeGames') and avail['seasons_with_stats'] > 0:
            # Estimate games from seasons (13 games/season average for FBS)
            f['collegeGames'] = avail['seasons_with_stats'] * 13
            changed = True

        if changed:
            patched += 1

    print(f"  Patched {patched} rookie training rows")

    # Save availability data
    print(f"  Saving to {OUTPUT_PATH}...")
    with open(OUTPUT_PATH, 'w') as f:
        json.dump(results, f)

    if not dry_run:
        print(f"  Saving patched cache to {CACHE_PATH}...")
        with open(CACHE_PATH, 'w') as f:
            json.dump(cached, f)
        print("Done.")
    else:
        print("[DRY RUN] No cache changes written.")


if __name__ == '__main__':
    main()
