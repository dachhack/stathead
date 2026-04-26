"""
Augment depthChartRank on training rows using historical depth-chart
files. The training-rows cache (v49) has every QB row at value 99
(default) because the feature was wired in to buildFeatureMatrix
after the cache was built — so the cache never carried the real
depth-chart signal.

Historical schema (2010–2025): season, club_code, week, depth_team
(rank), position, full_name, formation.
2026 schema: dt, team, pos_abb, pos_rank, player_name.

Pull week=1 (or earliest available) per (season, team, player) for
historical years; pull latest dt per (player) for 2026. Mutate the
cache in place.
"""
import json, gzip, csv
from pathlib import Path
from collections import defaultdict

CACHE_PATH = Path('public/data/training-rows-cache-v49.json')


def normname(n):
    s = (n or '').lower().replace('.', '').replace("'", '')
    for suf in [' jr', ' sr', ' ii', ' iii', ' iv', ' v']:
        if s.endswith(suf):
            s = s[:-len(suf)]
    return ' '.join(s.split())


def load_depth_chart(season):
    """Returns {(team, position, normalized_name): rank} for the season."""
    path = Path('public/data') / f'depth_charts_{season}.csv.gz'
    if not path.exists():
        return {}
    out = {}
    with gzip.open(path, 'rt') as f:
        rdr = csv.DictReader(f)
        # Detect schema by checking field names
        fields = rdr.fieldnames or []
        is_modern = 'pos_abb' in fields  # 2026+
        is_historical = 'depth_team' in fields  # 2010–2025

        if is_modern:
            # 2026 schema — take latest dt per player
            latest_per_player = {}
            for r in rdr:
                team = r.get('team', '')
                pos = r.get('pos_abb', '')
                name = normname(r.get('player_name', ''))
                rank_raw = r.get('pos_rank', '') or r.get('pos_slot', '')
                try:
                    rank = int(rank_raw)
                except (ValueError, TypeError):
                    continue
                dt = r.get('dt', '')
                key = (team, pos, name)
                if key not in latest_per_player or dt > latest_per_player[key][0]:
                    latest_per_player[key] = (dt, rank)
            for key, (_, rank) in latest_per_player.items():
                out[key] = rank
        elif is_historical:
            # Historical schema — take week=1 per player (Offense formation only)
            for r in rdr:
                if r.get('formation') != 'Offense':
                    continue
                if r.get('week') != '1':
                    continue
                team = r.get('club_code', '')
                pos = r.get('position', '')
                name = normname(r.get('full_name', ''))
                try:
                    rank = int(r.get('depth_team', ''))
                except (ValueError, TypeError):
                    continue
                key = (team, pos, name)
                if key not in out:  # first week-1 entry wins (preseason snapshot)
                    out[key] = rank
    return out


def main():
    print(f'Loading {CACHE_PATH}…')
    with open(CACHE_PATH) as f:
        cache = json.load(f)
    rows = cache['rows']
    print(f'  {len(rows)} rows')

    seasons = sorted({r['season'] for r in rows})
    by_season = {}
    for s in seasons:
        by_season[s] = load_depth_chart(s)
        print(f'  Loaded {len(by_season[s])} entries from depth_charts_{s}.csv.gz')

    # Build position → {name → rank} per season for unified lookup
    # (we don't always know team in the cache row, so search by (pos, name))
    by_season_pos_name = {}
    for s, dct in by_season.items():
        m = {}
        for (team, pos, name), rank in dct.items():
            m.setdefault((pos, name), []).append((team, rank))
        by_season_pos_name[s] = m

    changed = 0
    samples_qb = []
    for r in rows:
        season = r['season']
        nm = normname(r.get('name', ''))
        pos = r['position']
        candidates = by_season_pos_name.get(season, {}).get((pos, nm), [])
        if not candidates:
            continue
        # Pick the lowest rank if multiple teams (player traded mid-season)
        rank = min(c[1] for c in candidates)
        old = r['features'].get('depthChartRank', 99)
        if old != rank:
            changed += 1
            if pos == 'QB' and len(samples_qb) < 6 and r['season'] >= 2023:
                samples_qb.append((r['name'], r['season'], old, rank))
        r['features']['depthChartRank'] = rank
        r['features']['isProjectedStarter'] = 1 if rank == 1 else 0

    print(f'\n  Changed {changed}/{len(rows)} rows')
    if samples_qb:
        print('  Recent QB samples (old → new):')
        for nm, s, o, n in samples_qb:
            print(f'    {nm} {s}: {o} → {n}')

    # Distribution per position
    print('\nNew depthChartRank distribution per position:')
    by_pos = defaultdict(lambda: defaultdict(int))
    for r in rows:
        v = r['features'].get('depthChartRank', 99)
        by_pos[r['position']][v] += 1
    for pos in ['QB', 'RB', 'WR', 'TE']:
        print(f'  {pos}: ' + ', '.join(f'{k}: {by_pos[pos][k]}' for k in sorted(by_pos[pos].keys())))

    print(f'\nWriting cache back…')
    with open(CACHE_PATH, 'w') as f:
        json.dump(cache, f)
    size_mb = CACHE_PATH.stat().st_size / 1024 / 1024
    print(f'  Wrote {CACHE_PATH} ({size_mb:.1f} MB)')


if __name__ == '__main__':
    main()
